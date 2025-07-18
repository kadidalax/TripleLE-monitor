# 🔥 TripleLE论坛监控推送系统

基于Cloudflare Workers + D1数据库的LET/LES/LEB论坛监控推送系统，支持AI智能总结和Telegram自动推送。

## ✨ 核心功能

- **多论坛监控**: 支持LowEndTalk、LowEndSpirit、LowEndBox等论坛RSS监控
- **AI智能总结**: 多AI提供商支持，将帖子总结成1-3句话，重点关注VPS配置和价格
- **Telegram推送**: 格式化推送到频道，包含标题、作者、时间、总结和链接
- **管理后台**: 简洁美观的配置界面，支持AI设置、Telegram设置和系统监控
- **自动化运行**: 每5分钟自动监控，AI处理间隔15秒，7天数据自动清理

## 🚀 面板部署指南

### 第一步：创建D1数据库
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → **D1** 标签
3. 点击 **Create database**，名称随意，如：`triplele_monitor_db`
4. 点击 **Create** 创建数据库

### 第二步：创建Worker
1. 在 **Workers & Pages** 中点击 **Create application** → **Create Worker**
2. Worker名称随意，如：`triplele-monitor`
3. 点击 **Deploy** 创建Worker

### 第三步：上传代码
1. 在Worker详情页面，点击 **Edit code**
2. 删除编辑器中的所有默认代码
3. 复制 `worker.js` 的完整内容（1566行）并粘贴
4. 点击 **Save and deploy** 等待部署完成

### 第四步：配置数据库绑定
1. 进入 **绑定** 标签 → **添加绑定**
2. 在 **D1 database bindings** 部分点击 **Add binding**
3. Variable name: `DB`，D1 database: 选择 `triplele_monitor_db`
4. 点击 **Save and deploy**

### 第五步：配置环境变量
在 **Environment variables** 部分添加以下变量：

| 变量名 | 值 | 类型 | 说明 |
|--------|---|------|------|
| `ADMIN_PASSWORD` | `your-secure-password` | Text | 管理后台密码（必需） |

添加变量后都点击 **Save and deploy**

### 第六步：配置定时触发器
1. 进入 **Triggers** 标签页
2. 点击 **Add Cron Trigger**
3. Cron expression: `*/5 * * * *` （建议每5分钟执行一次）
4. 点击 **Add Trigger**

### 第七步：访问管理界面
1. 访问Worker URL（如：`https://triplele-monitor.your-subdomain.workers.dev`）

2. 使用设置的管理员密码登录

3. 在管理界面中配置AI和Telegram设置

4. 点击"手动同步RSS"和"测试Telegram"验证功能

### 第八步：配置CF Worker AI（可选）

1. 进入 **绑定** 标签 → **添加绑定**
2. 在 **Worker AI** 部分点击 **Add binding**
3. Variable name: `AI`
4. 点击 **Save and deploy**
5. 后台使用CF Worker AI 时，API地址 和 密钥留空，模型填写`@cf/meta/llama-3.1-8b-instruct
`

## 📋 推送格式示例

系统会将论坛帖子格式化推送到Telegram：

```
🔥 LET 促销
📝 标题：[VPS] 超值VPS优惠 - 2核4G内存仅$5/月
👤 作者：dealmaster
⏰ 发布时间：2025-01-17 18:00
📋 总结：提供2核CPU、4GB内存、50GB SSD存储的VPS，月付仅需5美元，支持多个数据中心选择，适合个人建站使用。
🔗 查看原文（点击可跳转）
```

## 📱 管理界面功能

### 🤖 AI设置
- 支持OpenAI、Gemini、OpenAI兼容、Cloudflare Workers AI
- 可配置API URL、密钥、模型名称和提示词模板
- 一键测试AI连接功能

### 📱 Telegram设置
- 配置Bot Token和频道ID
- 测试消息发送功能
- 查看推送状态

### 📊 系统监控
- 实时查看帖子数量、处理状态
- 监控AI处理进度和Telegram发送状态
- 手动同步RSS和刷新系统状态

## 📊 监控的论坛

| 论坛 | RSS源 | 说明 |
|------|-------|------|
| LET General | `lowendtalk.com/categories/general/feed.rss` | LowEndTalk综合讨论 |
| LET Offers | `lowendtalk.com/categories/offers/feed.rss` | LowEndTalk优惠信息 |
| LET Request | `talk.lowendspirit.com/discussions/feed.rss` | LowEndTalk需求讨论 |
| LEB | `lowendbox.com/feed/` | LowEndBox VPS评测 |
| LES | `lowendspirit.com/discussions/feed.rss` | LowEndSpirit讨论 |

## 🛠️ 技术特性

- **单文件架构**: 所有功能集成在worker.js中，便于部署
- **批量优化**: 使用D1 batch API减少数据库调用
- **智能重试**: 失败任务自动重试，超过3次标记为已处理
- **数据清理**: 7天数据保留，每2天自动清理过期数据
- **频率控制**: AI处理间隔15秒，避免API限制
- **错误处理**: 完善的错误捕获和日志记录

## 🆘 常见问题

### 部署问题
- **数据库连接失败**: 检查D1数据库绑定，确认Variable name为`DB`
- **代码上传失败**: 确保复制完整的worker.js内容（1566行）
- **环境变量无效**: 添加变量后必须点击"Save and deploy"

### 功能问题
- **AI调用失败**: 在管理界面测试AI配置，检查API URL和密钥
- **Telegram发送失败**: 使用"测试Telegram"功能，确认Bot Token和频道ID正确
- **定时任务不执行**: 检查Cron触发器配置为`*/5 * * * *`

### 调试方法
1. 在Worker详情页面查看**Logs**标签的实时日志
2. 使用管理界面的测试功能验证各项配置
3. 如有问题可重新部署Worker代码

---

**注意**: 请遵守各论坛的使用条款和API使用限制。本项目仅供学习和个人使用。

