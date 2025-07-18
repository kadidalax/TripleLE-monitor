/**
 * TripleLE Forum Monitor & Push System
 * 监控LET/LES/LEB论坛促销帖子并推送到Telegram频道
 */

// ==================== 配置常量 ====================

const RSS_SOURCES = {
  LET_General: 'https://lowendtalk.com/categories/general/feed.rss',
  LET_Offers: 'https://lowendtalk.com/categories/offers/feed.rss',
  LET_Discussions: 'https://talk.lowendspirit.com/discussions/feed.rss',
  LEB: 'https://lowendbox.com/feed/',
  LES: 'https://lowendspirit.com/discussions/feed.rss'
};

const AI_PROVIDERS = {
  openai: { format: 'openai', endpoint: '/v1/chat/completions' },
  gemini: { format: 'gemini', endpoint: '/v1/models/gemini-pro:generateContent' },
  openai_like: { format: 'openai', endpoint: '/chat/completions' },
  cf_workers: { format: 'cf_workers', endpoint: '@cf/meta/llama-3-8b-instruct' }
};

const DEFAULT_PROMPT = `请分析以下帖子内容，完成两个任务：

1. 判断帖子类型：如果是VPS/服务器销售、促销、优惠、特价等商业推广内容，回复"促销"；如果是求助、讨论、分享等非商业内容，回复"其他"。

2. 总结内容：
   - 如果有详细内容：将帖子总结成1-3句话，重点关注VPS配置、价格、免费、赠送等信息
   - 如果只有标题：根据标题判断类型并简要说明，不要说"没有提供内容"

帖子内容：{content}

请按以下格式回复：
类型：[促销/其他]
总结：[1-3句话的总结，基于可用信息进行分析]`;

// ==================== 数据库初始化 ====================

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  forum TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  publish_time TEXT,
  content TEXT,
  link TEXT UNIQUE,
  processed INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  post_id INTEGER,
  summary TEXT,
  post_type TEXT DEFAULT '其他',
  sent_to_telegram INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_processed ON posts(processed);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_summaries_sent ON summaries(sent_to_telegram);
`;

// ==================== 核心工具类 ====================

class Utils {
  static getCurrentTimestamp() {
    return new Date().toISOString();
  }

  static log(level, message, data = null) {
    const timestamp = Utils.getCurrentTimestamp();
    const logEntry = { timestamp, level, message, data };
    console.log(JSON.stringify(logEntry));
  }

  static async withErrorHandling(fn, context = 'Unknown') {
    try {
      return await fn();
    } catch (error) {
      Utils.log('ERROR', `Error in ${context}`, {
        message: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static cleanText(text) {
    if (!text) return '';
    return text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  static extractTag(content, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = content.match(regex);
    return match ? match[1] : '';
  }

  static formatDateTime(dateString) {
    if (!dateString) return '未知';
    try {
      const date = new Date(dateString);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    } catch (error) {
      return dateString;
    }
  }

  static escapeJsString(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\')
              .replace(/'/g, "\\'")
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t');
  }
}

// ==================== 数据库管理器 ====================

class DatabaseManager {
  constructor(env) {
    this.env = env;
    this.db = env.DB;
    this.initialized = false;
    this.lastInitTime = 0;
    this.INIT_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24小时缓存
  }

  async init() {
    return Utils.withErrorHandling(async () => {
      const now = Date.now();

      // 如果最近24小时内已初始化，跳过大部分操作
      if (this.initialized && (now - this.lastInitTime) < this.INIT_CACHE_DURATION) {
        Utils.log('DEBUG', 'Database already initialized recently, skipping');
        return;
      }

      // 快速检查关键表是否存在
      try {
        const tablesExist = await this.db.prepare(`
          SELECT COUNT(*) as count FROM sqlite_master
          WHERE type='table' AND name IN ('posts', 'summaries', 'settings')
        `).first();

        if (tablesExist.count >= 3) {
          this.initialized = true;
          this.lastInitTime = now;
          Utils.log('DEBUG', 'All tables exist, skipping full initialization');
          return;
        }
      } catch (error) {
        Utils.log('WARN', 'Failed to check table existence, proceeding with full initialization');
      }

      // 执行完整初始化
      Utils.log('INFO', 'Performing full database initialization');
      const statements = DB_SCHEMA.split(';').filter(stmt => stmt.trim());
      for (const statement of statements) {
        if (statement.trim()) {
          await this.db.prepare(statement).run();
        }
      }

      this.initialized = true;
      this.lastInitTime = Date.now();
      Utils.log('INFO', 'Database initialized successfully');
    }, 'DatabaseManager.init');
  }

  // 统一的重试计数更新函数
  async incrementRetryCount(table, idField, id, maxRetries = 3) {
    return Utils.withErrorHandling(async () => {
      const result = await this.db.prepare(`
        UPDATE ${table} 
        SET retry_count = COALESCE(retry_count, 0) + 1 
        WHERE ${idField} = ?
      `).bind(id).run();

      // 检查是否达到最大重试次数
      const record = await this.db.prepare(`
        SELECT retry_count FROM ${table} WHERE ${idField} = ?
      `).bind(id).first();

      if (record && record.retry_count >= maxRetries) {
        await this.markAsProcessed(table, idField, id);
        Utils.log('WARN', `${table} ${id} failed after ${record.retry_count} attempts, marked as processed`);
        return { reachedMaxRetries: true, retryCount: record.retry_count };
      }

      Utils.log('DEBUG', `Incremented retry count for ${table} ${id}`, {
        retryCount: record?.retry_count || 0
      });
      return { reachedMaxRetries: false, retryCount: record?.retry_count || 0 };
    }, `DatabaseManager.incrementRetryCount(${table}, ${id})`);
  }

  // 统一的标记为已处理函数
  async markAsProcessed(table, idField, id) {
    return Utils.withErrorHandling(async () => {
      await this.db.prepare(`
        UPDATE ${table} SET processed = 1 WHERE ${idField} = ?
      `).bind(id).run();
    }, `DatabaseManager.markAsProcessed(${table}, ${id})`);
  }

  // 统一的批量插入函数
  async batchInsert(table, records, conflictResolution = 'IGNORE') {
    return Utils.withErrorHandling(async () => {
      if (!records || records.length === 0) return [];

      const columns = Object.keys(records[0]);
      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT OR ${conflictResolution} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

      const statements = records.map(record => 
        this.db.prepare(sql).bind(...columns.map(col => record[col]))
      );

      const results = await this.db.batch(statements);
      const insertedCount = results.filter(r => r.changes > 0).length;
      
      Utils.log('INFO', `Batch inserted ${insertedCount} records into ${table}`);
      return results;
    }, `DatabaseManager.batchInsert(${table})`);
  }

  // 清理过期数据
  async cleanupOldData() {
    return Utils.withErrorHandling(async () => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const cutoffDate = sevenDaysAgo.toISOString();

      // 清理过期帖子和相关总结
      const deletePostsResult = await this.db.prepare(`
        DELETE FROM posts WHERE created_at < ?
      `).bind(cutoffDate).run();

      const deleteSummariesResult = await this.db.prepare(`
        DELETE FROM summaries WHERE created_at < ?
      `).bind(cutoffDate).run();

      Utils.log('INFO', 'Cleanup completed', {
        deletedPosts: deletePostsResult.changes,
        deletedSummaries: deleteSummariesResult.changes,
        cutoffDate
      });

      return {
        deletedPosts: deletePostsResult.changes,
        deletedSummaries: deleteSummariesResult.changes
      };
    }, 'DatabaseManager.cleanupOldData');
  }
}

// ==================== 配置管理器 ====================

class ConfigManager {
  constructor(env) {
    this.env = env;
    this.db = env.DB;
    this.cache = new Map();
    this.cacheDuration = 5 * 60 * 1000; // 5分钟缓存
  }

  async get(key, defaultValue = null) {
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.value;
    }

    const value = await this.getSetting(key) || defaultValue;
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });

    return value;
  }

  async set(key, value) {
    await this.setSetting(key, value);
    this.cache.delete(key); // 清除缓存
  }

  async getAIConfig() {
    return {
      provider: await this.get('ai_provider', 'openai_like'),
      url: await this.get('ai_url', this.env.DEFAULT_AI_URL || ''),
      apiKey: await this.get('ai_api_key', this.env.DEFAULT_AI_KEY || ''),
      model: await this.get('ai_model', this.env.DEFAULT_AI_MODEL || 'gpt-3.5-turbo'),
      prompt: await this.get('ai_prompt', DEFAULT_PROMPT)
    };
  }

  async getTelegramConfig() {
    return {
      botToken: await this.get('tg_bot_token', this.env.DEFAULT_TG_TOKEN || ''),
      channelId: await this.get('tg_channel_id', this.env.DEFAULT_TG_CHANNEL || '')
    };
  }

  async setSetting(key, value) {
    await this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).bind(key, value, Utils.getCurrentTimestamp()).run();
  }

  async getSetting(key) {
    try {
      const result = await this.db.prepare(`
        SELECT value FROM settings WHERE key = ?
      `).bind(key).first();
      return result ? result.value : null;
    } catch (error) {
      Utils.log('WARN', `Failed to get setting ${key}`, { error: error.message });
      return null;
    }
  }

  clearCache() {
    this.cache.clear();
  }
}

// ==================== AI服务管理器 ====================

class AIServiceManager {
  constructor(env, configManager) {
    this.env = env;
    this.configManager = configManager;
  }

  async callAI(prompt) {
    return Utils.withErrorHandling(async () => {
      const config = await this.configManager.getAIConfig();

      let result;
      switch (config.provider) {
        case 'openai':
        case 'openai_like':
          result = await this.callOpenAILikeAPI(prompt, config);
          break;
        case 'gemini':
          result = await this.callGeminiAPI(prompt, config);
          break;
        case 'cf_workers':
          result = await this.callCFWorkersAI(prompt, config);
          break;
        default:
          throw new Error(`Unsupported AI provider: ${config.provider}`);
      }

      if (!result) return null;

      // 解析AI返回的结果
      return this.parseAIResponse(result);
    }, 'AIServiceManager.callAI');
  }

  async callOpenAILikeAPI(prompt, config) {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  async callGeminiAPI(prompt, config) {
    const response = await fetch(`${config.url}?key=${config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.7 }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  }

  async callCFWorkersAI(prompt, config) {
    if (!this.env?.AI) {
      throw new Error('Cloudflare Workers AI not available');
    }

    const response = await this.env.AI.run(config.model, {
      messages: [{ role: 'user', content: prompt }]
    });

    return response?.response?.trim() || null;
  }

  parseAIResponse(aiResult) {
    try {
      const typeMatch = aiResult.match(/类型[：:]\s*(促销|其他)/i);
      const summaryMatch = aiResult.match(/总结[：:]\s*(.+)/is);

      let postType = '其他';
      let summary = aiResult;

      if (typeMatch && summaryMatch) {
        postType = typeMatch[1].trim();
        summary = summaryMatch[1].trim();
      } else {
        const lowerResult = aiResult.toLowerCase();
        if (lowerResult.includes('促销') || lowerResult.includes('优惠') ||
            lowerResult.includes('特价') || lowerResult.includes('折扣') ||
            lowerResult.includes('免费') || lowerResult.includes('赠送') ||
            lowerResult.includes('price') || lowerResult.includes('offer') ||
            lowerResult.includes('deal') || lowerResult.includes('discount')) {
          postType = '促销';
        }
      }

      return { postType, summary };
    } catch (error) {
      Utils.log('WARN', 'Failed to parse AI response, using defaults', { error: error.message });
      return { postType: '其他', summary: aiResult };
    }
  }
}

// ==================== 网络请求管理器 ====================

class NetworkManager {
  constructor() {
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0'
    };
  }

  async fetchWithRetry(url, options = {}) {
    return Utils.withErrorHandling(async () => {
      const maxRetries = options.maxRetries || 3;
      const retryDelay = options.retryDelay || 5000;
      let lastError;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          Utils.log('INFO', `Fetching attempt ${attempt}/${maxRetries}`, { url });

          // 添加随机延迟避免被检测
          if (options.delay !== false) {
            const delayMs = options.delay || Math.random() * 2000 + 1000;
            await Utils.delay(delayMs);
          }

          const headers = { ...this.defaultHeaders, ...options.headers };
          const response = await fetch(url, {
            method: options.method || 'GET',
            headers,
            ...options.fetchOptions
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }

          const content = await response.text();

          // 检查是否被Cloudflare拦截
          if (content.includes('Checking your browser') ||
              content.includes('cloudflare') ||
              content.includes('cf-browser-verification')) {
            throw new Error('Cloudflare protection detected');
          }

          if (attempt > 1) {
            Utils.log('INFO', `Successfully fetched after ${attempt} attempts`, { url });
          }

          return content;

        } catch (error) {
          lastError = error;
          Utils.log('WARN', `Fetch attempt ${attempt} failed`, {
            url,
            error: error.message,
            willRetry: attempt < maxRetries
          });

          if (attempt < maxRetries) {
            await Utils.delay(retryDelay);
          }
        }
      }

      Utils.log('ERROR', `All ${maxRetries} fetch attempts failed`, { url, lastError: lastError.message });
      throw lastError;
    }, `NetworkManager.fetchWithRetry(${url})`);
  }

  async fetchRSS(url) {
    return Utils.withErrorHandling(async () => {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'TripleLE-Monitor/1.0' }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch RSS: ${response.status} ${response.statusText}`);
      }

      return await response.text();
    }, `NetworkManager.fetchRSS(${url})`);
  }

  async fetchLETPage(url, options = {}) {
    return Utils.withErrorHandling(async () => {
      const letOptions = {
        ...options,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://lowendtalk.com/',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          ...options.headers
        },
        maxRetries: 3,
        retryDelay: 3000,
        delay: 2000
      };

      Utils.log('INFO', `Fetching LET page: ${url}`);
      const content = await this.fetchWithRetry(url, letOptions);

      if (!content || content.length < 1000) {
        throw new Error('Page content too short, possibly blocked');
      }

      if (!content.includes('lowendtalk') && !content.includes('Vanilla')) {
        Utils.log('WARN', 'Page does not appear to be a valid LET page', { url });
      }

      Utils.log('INFO', `Successfully fetched LET page: ${url}`, {
        contentLength: content.length
      });

      return content;
    }, `NetworkManager.fetchLETPage(${url})`);
  }

  // 内容提取函数
  extractPostContent(htmlContent) {
    try {
      const patterns = [
        /<div[^>]*class="[^"]*Message[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class="[^"]*UserContent[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class="[^"]*Content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i,
        /<main[^>]*>([\s\S]*?)<\/main>/i
      ];

      for (const pattern of patterns) {
        const match = htmlContent.match(pattern);
        if (match && match[1]) {
          let content = match[1]
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();

          if (content.length > 50) {
            return content.length > 1000 ? content.substring(0, 1000) + '...' : content;
          }
        }
      }

      const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) {
        return `页面标题: ${titleMatch[1].trim()}`;
      }

      return null;
    } catch (error) {
      Utils.log('WARN', 'Failed to extract post content from HTML', { error: error.message });
      return null;
    }
  }
}

// ==================== RSS解析器 ====================

class RSSParser {
  constructor(networkManager) {
    this.networkManager = networkManager;
  }

  async parseRSSContent(rssContent) {
    return Utils.withErrorHandling(async () => {
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;

      while ((match = itemRegex.exec(rssContent)) !== null) {
        const itemContent = match[1];

        const title = Utils.extractTag(itemContent, 'title');
        const link = Utils.extractTag(itemContent, 'link');
        const description = Utils.extractTag(itemContent, 'description');
        const pubDate = Utils.extractTag(itemContent, 'pubDate');
        const author = Utils.extractTag(itemContent, 'author') || Utils.extractTag(itemContent, 'dc:creator');

        if (title && link) {
          items.push({
            title: Utils.cleanText(title),
            link: Utils.cleanText(link),
            content: Utils.cleanText(description),
            publishTime: pubDate ? new Date(pubDate).toISOString() : Utils.getCurrentTimestamp(),
            author: Utils.cleanText(author)
          });
        }
      }

      return items;
    }, 'RSSParser.parseRSSContent');
  }

  async syncAllRSS(env, dbManager) {
    return Utils.withErrorHandling(async () => {
      const allPosts = [];

      for (const [forumName, rssUrl] of Object.entries(RSS_SOURCES)) {
        try {
          Utils.log('INFO', `Syncing RSS for ${forumName}`, { url: rssUrl });

          const rssContent = await this.networkManager.fetchRSS(rssUrl);
          const posts = await this.parseRSSContent(rssContent);

          // 为每个帖子添加论坛标识
          const forumPosts = posts.map(post => ({
            ...post,
            forum: forumName
          }));

          allPosts.push(...forumPosts);
          Utils.log('INFO', `Fetched ${posts.length} posts from ${forumName}`);

          // 避免请求过于频繁
          await Utils.delay(1000);

        } catch (error) {
          Utils.log('ERROR', `Failed to sync RSS for ${forumName}`, {
            url: rssUrl,
            error: error.message
          });
        }
      }

      // 批量插入所有帖子（过滤7天内的帖子）
      if (allPosts.length > 0) {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const recentPosts = allPosts.filter(post => {
          if (!post.publishTime) return true;

          try {
            const publishDate = new Date(post.publishTime);
            const isRecent = publishDate >= sevenDaysAgo;

            if (!isRecent) {
              Utils.log('DEBUG', `Filtered out old post: ${post.title}`, {
                publishTime: post.publishTime,
                daysOld: Math.floor((new Date() - publishDate) / (1000 * 60 * 60 * 24))
              });
            }

            return isRecent;
          } catch (error) {
            Utils.log('WARN', `Invalid publish time format: ${post.publishTime}`, { title: post.title });
            return true;
          }
        });

        if (recentPosts.length > 0) {
          const records = recentPosts.map(post => ({
            forum: post.forum,
            title: post.title,
            author: post.author || '',
            publish_time: post.publishTime || '',
            content: post.content || '',
            link: post.link,
            created_at: Utils.getCurrentTimestamp()
          }));

          await dbManager.batchInsert('posts', records, 'IGNORE');
        }

        Utils.log('INFO', `RSS sync completed, processed ${recentPosts.length} recent posts from ${allPosts.length} total posts`);
      }
    }, 'RSSParser.syncAllRSS');
  }
}

// ==================== Telegram管理器 ====================

class TelegramManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.forumEmoji = {
      'LET': '🔥',
      'LES': '⚡',
      'LEB': '💎'
    };
  }

  formatTelegramMessage(summary) {
    const emoji = this.forumEmoji[summary.forum] || '📢';
    const postType = summary.post_type || '其他';

    // 生成标签，基于论坛来源和帖子类型
    const tag = this.generateHashTag(summary.forum, postType);

    // HTML转义函数
    const escapeHtml = (text) => {
      if (!text) return '';
      return text.replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;');
    };

    return `${emoji} ${summary.forum} ${postType}
📝 标题：${escapeHtml(summary.title)}
👤 作者：${escapeHtml(summary.author || '未知')}
⏰ 发布时间：${Utils.formatDateTime(summary.publish_time)}
📋 总结：${escapeHtml(summary.summary)}
🔗 <a href="${summary.link}">查看原文</a>

${tag}`;
  }

  generateHashTag(forum, postType) {
    // 根据论坛来源生成对应的标签，保持完整的RSS名称
    let tags = [];

    if (forum) {
      tags.push(`#${forum}`);
    } else {
      tags.push('#Unknown');
    }

    // 根据帖子类型添加标签
    if (postType) {
      tags.push(`#${postType}`);
    }

    return tags.join(' ');
  }

  async sendMessage(config, message) {
    return Utils.withErrorHandling(async () => {
      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.channelId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        Utils.log('ERROR', 'Telegram API error', {
          status: response.status,
          data: data
        });
        return false;
      }

      return true;
    }, 'TelegramManager.sendMessage');
  }

  async testConnection(config) {
    return Utils.withErrorHandling(async () => {
      const testMessage = `🤖 TripleLE监控系统测试消息

⏰ 测试时间：${Utils.formatDateTime(Utils.getCurrentTimestamp())}

✅ 如果您看到这条消息，说明Telegram配置正确！`;

      return await this.sendMessage(config, testMessage);
    }, 'TelegramManager.testConnection');
  }

  async sendPendingMessages(env, dbManager) {
    return Utils.withErrorHandling(async () => {
      // 获取未发送的帖子总结
      const unsentSummaries = await this.getUnsentSummaries(env.DB, 3);

      if (unsentSummaries.length === 0) {
        Utils.log('INFO', 'No unsent summaries found');
        return;
      }

      const tgConfig = await this.configManager.getTelegramConfig();

      if (!tgConfig.botToken || !tgConfig.channelId) {
        Utils.log('WARN', 'Telegram configuration incomplete');
        return;
      }

      // 发送帖子总结
      for (const summary of unsentSummaries) {
        try {
          Utils.log('INFO', `Sending post summary ${summary.id} to Telegram`);

          const message = this.formatTelegramMessage(summary);
          const success = await this.sendMessage(tgConfig, message);

          if (success) {
            await this.markSummaryAsSent(env.DB, summary.id);
            Utils.log('INFO', `Successfully sent post summary ${summary.id}`);
          } else {
            Utils.log('WARN', `Failed to send post summary ${summary.id}`);
          }

          await Utils.delay(2000);

        } catch (error) {
          Utils.log('ERROR', `Error sending post summary ${summary.id}`, {
            error: error.message
          });
        }
      }
    }, 'TelegramManager.sendPendingMessages');
  }

  async getUnsentSummaries(db, limit = 5) {
    const result = await db.prepare(`
      SELECT s.*, p.forum, p.title, p.author, p.publish_time, p.link
      FROM summaries s
      JOIN posts p ON s.post_id = p.id
      WHERE s.sent_to_telegram = 0
      ORDER BY s.created_at ASC
      LIMIT ?
    `).bind(limit).all();

    return result.results || [];
  }

  async markSummaryAsSent(db, summaryId) {
    await db.prepare(`
      UPDATE summaries SET sent_to_telegram = 1 WHERE id = ?
    `).bind(summaryId).run();
  }
}

// ==================== 业务逻辑管理器 ====================

class BusinessLogicManager {
  constructor(env) {
    this.env = env;
    this.dbManager = new DatabaseManager(env);
    this.configManager = new ConfigManager(env);
    this.aiManager = new AIServiceManager(env, this.configManager);
    this.networkManager = new NetworkManager();
    this.rssParser = new RSSParser(this.networkManager);
    this.telegramManager = new TelegramManager(this.configManager);
  }

  async init() {
    await this.dbManager.init();
  }

  // RSS同步和AI处理
  async processRSSAndAI() {
    return Utils.withErrorHandling(async () => {
      // 1. 同步RSS
      await this.rssParser.syncAllRSS(this.env, this.dbManager);

      // 2. 处理未处理的帖子
      await this.processUnprocessedPosts();

      // 3. 发送Telegram消息
      await this.telegramManager.sendPendingMessages(this.env, this.dbManager);

      // 4. 清理过期数据（每次都检查，但只在需要时执行）
      const lastCleanup = await this.configManager.get('last_cleanup');
      const now = Date.now();
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

      if (!lastCleanup || (now - parseInt(lastCleanup)) > twoDaysMs) {
        await this.dbManager.cleanupOldData();
        await this.configManager.set('last_cleanup', now.toString());
      }

    }, 'BusinessLogicManager.processRSSAndAI');
  }

  async processUnprocessedPosts() {
    return Utils.withErrorHandling(async () => {
      const unprocessedPosts = await this.getUnprocessedPosts(5);

      for (const post of unprocessedPosts) {
        try {
          Utils.log('INFO', `Processing post ${post.id}: ${post.title}`);

          // 获取帖子内容
          let content = post.content || '';
          if (!content || content.length < 50) {
            content = await this.fetchPostContent(post.link);
          }

          if (!content) {
            Utils.log('WARN', `No content found for post ${post.id}, marking as processed`);
            await this.dbManager.markAsProcessed('posts', 'id', post.id);
            continue;
          }

          // AI分析
          const prompt = (await this.configManager.getAIConfig()).prompt.replace('{content}',
            `标题: ${post.title}\n内容: ${content.substring(0, 1000)}`);

          const aiResult = await this.aiManager.callAI(prompt);

          if (aiResult) {
            // 保存AI总结
            await this.saveSummary(post.id, aiResult.summary, aiResult.postType);
            Utils.log('INFO', `AI analysis completed for post ${post.id}`, {
              postType: aiResult.postType,
              summaryLength: aiResult.summary.length
            });
          }

          // 标记为已处理
          await this.dbManager.markAsProcessed('posts', 'id', post.id);

          // 避免请求过于频繁
          await Utils.delay(3000);

        } catch (error) {
          Utils.log('ERROR', `Failed to process post ${post.id}`, {
            error: error.message,
            title: post.title
          });

          // 增加重试计数
          const retryResult = await this.dbManager.incrementRetryCount('posts', 'id', post.id);
          if (retryResult.reachedMaxRetries) {
            Utils.log('WARN', `Post ${post.id} reached max retries, marked as processed`);
          }
        }
      }
    }, 'BusinessLogicManager.processUnprocessedPosts');
  }

  // 数据库查询方法
  async getUnprocessedPosts(limit = 5) {
    const result = await this.env.DB.prepare(`
      SELECT * FROM posts
      WHERE processed = 0 AND retry_count < 3
      ORDER BY created_at ASC
      LIMIT ?
    `).bind(limit).all();

    return result.results || [];
  }

  async fetchPostContent(url) {
    try {
      const htmlContent = await this.networkManager.fetchLETPage(url);
      return this.networkManager.extractPostContent(htmlContent);
    } catch (error) {
      Utils.log('WARN', `Failed to fetch post content from ${url}`, { error: error.message });
      return null;
    }
  }

  async saveSummary(postId, summary, postType) {
    await this.env.DB.prepare(`
      INSERT INTO summaries (post_id, summary, post_type, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(postId, summary, postType, Utils.getCurrentTimestamp()).run();
  }
}

// ==================== 路由管理器 ====================

class Router {
  constructor() {
    this.routes = new Map();
    this.middlewares = [];
  }

  use(middleware) {
    this.middlewares.push(middleware);
  }

  get(path, handler) {
    this.addRoute('GET', path, handler);
  }

  post(path, handler) {
    this.addRoute('POST', path, handler);
  }

  addRoute(method, path, handler) {
    const key = `${method}:${path}`;
    this.routes.set(key, handler);
  }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const key = `${method}:${path}`;

    // 执行中间件
    for (const middleware of this.middlewares) {
      const result = await middleware(request, env, ctx);
      if (result) return result;
    }

    // 查找路由处理器
    const handler = this.routes.get(key);
    if (handler) {
      return await handler(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ==================== 主要处理函数 ====================

// 认证中间件
async function authMiddleware(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 跳过API路由的认证检查
  if (path.startsWith('/api/')) {
    return null;
  }

  const password = url.searchParams.get('password') || request.headers.get('Authorization');
  const adminPassword = env.ADMIN_PASSWORD || 'admin123';

  if (password !== adminPassword) {
    return new Response(getLoginPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  return null;
}

// 主页处理
async function handleHomePage(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    const stats = await getSystemStatus(env.DB);
    return new Response(getAdminPage(stats), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }, 'handleHomePage');
}

// 手动同步处理
async function handleManualSync(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    Utils.log('INFO', 'Manual sync triggered');
    await businessLogic.processRSSAndAI();

    return new Response(JSON.stringify({
      success: true,
      message: 'RSS同步和AI处理已完成'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }, 'handleManualSync');
}

// 系统状态处理
async function handleStatus(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    const stats = await getSystemStatus(env.DB);
    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' }
    });
  }, 'handleStatus');
}

// 配置处理函数
async function handleAISettings(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    if (request.method === 'POST') {
      const formData = await request.formData();
      const settings = {
        ai_provider: formData.get('ai_provider'),
        ai_url: formData.get('ai_url'),
        ai_api_key: formData.get('ai_api_key'),
        ai_model: formData.get('ai_model'),
        ai_prompt: formData.get('ai_prompt')
      };

      for (const [key, value] of Object.entries(settings)) {
        if (value) {
          await businessLogic.configManager.set(key, value);
        }
      }

      return new Response(JSON.stringify({ success: true, message: 'AI配置已保存' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const config = await businessLogic.configManager.getAIConfig();
    return new Response(JSON.stringify(config), {
      headers: { 'Content-Type': 'application/json' }
    });
  }, 'handleAISettings');
}

async function handleTelegramSettings(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    if (request.method === 'POST') {
      const formData = await request.formData();
      const settings = {
        tg_bot_token: formData.get('tg_bot_token'),
        tg_channel_id: formData.get('tg_channel_id')
      };

      for (const [key, value] of Object.entries(settings)) {
        if (value) {
          await businessLogic.configManager.set(key, value);
        }
      }

      return new Response(JSON.stringify({ success: true, message: 'Telegram配置已保存' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const config = await businessLogic.configManager.getTelegramConfig();
    return new Response(JSON.stringify(config), {
      headers: { 'Content-Type': 'application/json' }
    });
  }, 'handleTelegramSettings');
}

// 测试函数
async function handleAITest(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    const testContent = '测试内容：VPS促销，2核4G内存，月付$5，年付$50';
    const result = await businessLogic.aiManager.callAI(
      DEFAULT_PROMPT.replace('{content}', testContent)
    );

    return new Response(JSON.stringify({
      success: !!result,
      result: result || '测试失败'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }, 'handleAITest');
}

async function handleTelegramTest(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    const config = await businessLogic.configManager.getTelegramConfig();
    const success = await businessLogic.telegramManager.testConnection(config);

    return new Response(JSON.stringify({
      success: success,
      message: success ? 'Telegram连接测试成功' : 'Telegram连接测试失败'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }, 'handleTelegramTest');
}

// ==================== 系统状态和页面模板 ====================

async function getSystemStatus(db) {
  return Utils.withErrorHandling(async () => {
    const stats = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM posts) as total_posts,
        (SELECT COUNT(*) FROM posts WHERE processed = 0) as unprocessed_posts,
        (SELECT COUNT(*) FROM summaries) as total_summaries,
        (SELECT COUNT(*) FROM summaries WHERE sent_to_telegram = 0) as unsent_summaries
    `).first();

    return {
      totalPosts: stats.total_posts || 0,
      unprocessedPosts: stats.unprocessed_posts || 0,
      totalSummaries: stats.total_summaries || 0,
      unsentSummaries: stats.unsent_summaries || 0,
      lastUpdate: Utils.getCurrentTimestamp()
    };
  }, 'getSystemStatus');
}

function getLoginPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TripleLE监控系统 - 登录</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 50px; }
        .login-container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .login-container h1 { text-align: center; color: #333; margin-bottom: 30px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 5px; color: #555; }
        .form-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        .btn { width: 100%; padding: 12px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
        .btn:hover { background: #005a87; }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>🔐 TripleLE监控系统</h1>
        <form method="GET">
            <div class="form-group">
                <label for="password">管理员密码：</label>
                <input type="password" id="password" name="password" required>
            </div>
            <button type="submit" class="btn">登录</button>
        </form>
    </div>
</body>
</html>`;
}

function getAdminPage(stats) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TripleLE监控系统 - 管理面板</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .header h1 { margin: 0; color: #333; }

        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
        .stat-card h3 { margin: 0 0 10px 0; color: #666; font-size: 14px; }
        .stat-card .number { font-size: 32px; font-weight: bold; color: #007cba; }
        .actions { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .actions h2 { margin-top: 0; color: #333; }
        .btn-group { display: flex; gap: 10px; flex-wrap: wrap; }
        .btn { padding: 10px 20px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; }
        .btn:hover { background: #005a87; }
        .btn.secondary { background: #6c757d; }
        .btn.secondary:hover { background: #545b62; }
        .config-section { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .config-section h2 { margin-top: 0; color: #333; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; color: #555; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        .form-group textarea { height: 100px; resize: vertical; }
        .status { padding: 10px; border-radius: 4px; margin: 10px 0; }
        .status.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .status.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .status.info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
        .footer { text-align: center; color: #666; margin-top: 40px; }

    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 TripleLE监控系统 - 管理面板</h1>
            <p>最后更新：${Utils.formatDateTime(stats.lastUpdate)}</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <h3>总帖子数</h3>
                <div class="number">${stats.totalPosts}</div>
            </div>
            <div class="stat-card">
                <h3>未处理帖子</h3>
                <div class="number">${stats.unprocessedPosts}</div>
            </div>
            <div class="stat-card">
                <h3>AI总结数</h3>
                <div class="number">${stats.totalSummaries}</div>
            </div>
            <div class="stat-card">
                <h3>未发送消息</h3>
                <div class="number">${stats.unsentSummaries}</div>
            </div>
        </div>

        <div class="actions">
            <h2>🎛️ 系统操作</h2>
            <div class="btn-group">
                <button class="btn" onclick="manualSync()">手动同步RSS</button>
                <button class="btn secondary" onclick="refreshStatus()">刷新状态</button>
                <button class="btn secondary" onclick="testAI()">测试AI</button>
                <button class="btn secondary" onclick="testTelegram()">测试Telegram</button>
            </div>
            <div id="actionStatus"></div>
        </div>

        <div class="config-section">
            <h2>🤖 AI配置</h2>
            <form id="aiConfigForm">
                <div class="form-group">
                    <label for="ai_provider">AI提供商：</label>
                    <select id="ai_provider" name="ai_provider">
                        <option value="openai_like">OpenAI兼容</option>
                        <option value="openai">OpenAI</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="cf_workers">Cloudflare Workers AI</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="ai_url">API地址：</label>
                    <input type="url" id="ai_url" name="ai_url" placeholder="https://api.example.com/v1/chat/completions">
                </div>
                <div class="form-group">
                    <label for="ai_api_key">API密钥：</label>
                    <input type="password" id="ai_api_key" name="ai_api_key" placeholder="your-api-key">
                </div>
                <div class="form-group">
                    <label for="ai_model">模型名称：</label>
                    <input type="text" id="ai_model" name="ai_model" placeholder="gpt-3.5-turbo">
                </div>
                <div class="form-group">
                    <label for="ai_prompt">AI提示词：</label>
                    <textarea id="ai_prompt" name="ai_prompt" placeholder="请输入AI分析提示词...">${DEFAULT_PROMPT}</textarea>
                </div>
                <button type="submit" class="btn">保存AI配置</button>
            </form>
        </div>

        <div class="config-section">
            <h2>📱 Telegram配置</h2>
            <form id="telegramConfigForm">
                <div class="form-group">
                    <label for="tg_bot_token">Bot Token：</label>
                    <input type="password" id="tg_bot_token" name="tg_bot_token" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz">
                </div>
                <div class="form-group">
                    <label for="tg_channel_id">频道ID：</label>
                    <input type="text" id="tg_channel_id" name="tg_channel_id" placeholder="@your_channel 或 -1001234567890">
                </div>
                <button type="submit" class="btn">保存Telegram配置</button>
            </form>
        </div>

        <div class="footer">
            <p>TripleLE监控系统 | 监控LET/LES/LEB论坛促销信息</p>
        </div>
    </div>

    <script>
        // JavaScript代码
        async function manualSync() {
            showStatus('正在执行手动同步...', 'info');
            try {
                const response = await fetch('/api/manual-sync', { method: 'POST' });
                const result = await response.json();
                showStatus(result.message, result.success ? 'success' : 'error');
                if (result.success) setTimeout(refreshStatus, 2000);
            } catch (error) {
                showStatus('同步失败: ' + error.message, 'error');
            }
        }

        async function refreshStatus() {
            location.reload();
        }

        async function testAI() {
            showStatus('正在测试AI连接...', 'info');
            try {
                const response = await fetch('/api/test-ai', { method: 'POST' });
                const result = await response.json();
                showStatus('AI测试: ' + (result.success ? '成功' : '失败'), result.success ? 'success' : 'error');
            } catch (error) {
                showStatus('AI测试失败: ' + error.message, 'error');
            }
        }

        async function testTelegram() {
            showStatus('正在测试Telegram连接...', 'info');
            try {
                const response = await fetch('/api/test-telegram', { method: 'POST' });
                const result = await response.json();
                showStatus(result.message, result.success ? 'success' : 'error');
            } catch (error) {
                showStatus('Telegram测试失败: ' + error.message, 'error');
            }
        }

        function showStatus(message, type) {
            const statusDiv = document.getElementById('actionStatus');
            statusDiv.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
            if (type !== 'info') {
                setTimeout(() => statusDiv.innerHTML = '', 5000);
            }
        }

        // 表单提交处理
        document.getElementById('aiConfigForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            try {
                const response = await fetch('/api/settings/ai', { method: 'POST', body: formData });
                const result = await response.json();
                showStatus(result.message, result.success ? 'success' : 'error');
            } catch (error) {
                showStatus('保存失败: ' + error.message, 'error');
            }
        });

        document.getElementById('telegramConfigForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            try {
                const response = await fetch('/api/settings/telegram', { method: 'POST', body: formData });
                const result = await response.json();
                showStatus(result.message, result.success ? 'success' : 'error');
            } catch (error) {
                showStatus('保存失败: ' + error.message, 'error');
            }
        });
    </script>
</body>
</html>`;
}

// ==================== 主要导出函数 ====================

// 设置路由
function setupRoutes() {
  const router = new Router();

  // 添加认证中间件
  router.use(authMiddleware);

  // 页面路由
  router.get('/', handleHomePage);

  // API路由
  router.post('/api/manual-sync', handleManualSync);
  router.get('/api/status', handleStatus);
  router.get('/api/settings/ai', handleAISettings);
  router.post('/api/settings/ai', handleAISettings);
  router.get('/api/settings/telegram', handleTelegramSettings);
  router.post('/api/settings/telegram', handleTelegramSettings);
  router.post('/api/test-ai', handleAITest);
  router.post('/api/test-telegram', handleTelegramTest);

  return router;
}

// 主要的请求处理函数
async function handleRequest(request, env, ctx) {
  return Utils.withErrorHandling(async () => {
    const router = setupRoutes();
    return await router.handle(request, env, ctx);
  }, 'handleRequest');
}

// 定时任务处理函数
async function handleScheduled(event, env, ctx) {
  return Utils.withErrorHandling(async () => {
    Utils.log('INFO', 'Scheduled task started', {
      scheduledTime: new Date(event.scheduledTime).toISOString()
    });

    const businessLogic = new BusinessLogicManager(env);
    await businessLogic.init();

    // 执行RSS同步和AI处理
    await businessLogic.processRSSAndAI();

    Utils.log('INFO', 'Scheduled task completed');
  }, 'handleScheduled');
}

// 导出主要函数
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  }
};


