# 私账 · 资产实时看板

**在线使用：<https://huangxuejie-git.github.io/sizhang/>**

一个只保存在手机本地的资产看板。支持 **A 股 / 场内 ETF、场外基金、现金**，自动刷新行情，实时看总资产和今日变化。

- 纯静态 PWA，无需后端、无需注册
- 持仓和金额只存 `localStorage`，不上传
- 可添加到 Android 主屏幕，全屏运行
- 支持导出 / 导入 JSON 备份

## 本地预览

在项目目录启动任意静态服务器（不要直接双击 `index.html`，ES module 和 PWA 需要 HTTP）：

```powershell
# 任选一种
python -m http.server 5188
# 或
npx serve .
```

打开 `http://127.0.0.1:5188`。

## 部署到 GitHub Pages

1. 在 GitHub 新建一个空仓库，例如 `sizhang`（不要勾选 README）。
2. 在本目录执行：

```powershell
git init
git add .
git commit -m "feat: 私账资产看板"
git branch -M main
git remote add origin https://github.com/<你的用户名>/sizhang.git
git push -u origin main
```

3. 打开仓库 **Settings → Pages**：
   - Source 选择 **Deploy from a branch**
   - Branch 选择 **main**，目录选择 **/ (root)**
   - 保存。
4. 等 1–2 分钟，访问：

```
https://<你的用户名>.github.io/sizhang/
```

5. 手机 Chrome 打开该地址 → 右上角菜单 → **添加到主屏幕 / 安装应用**。

> 仓库里的 `.nojekyll` 已关闭 Jekyll，静态文件会原样发布。

## 行情与限制

| 资产 | 数据 | 刷新 |
| --- | --- | --- |
| 股票 / 场内 ETF | 腾讯证券公开行情 | 交易时段 5–60 秒可调，约 5–10 秒延迟 |
| 场外基金 | 基金公司最新公布净值 | 每个交易日更新一次，**没有实时估值** |
| 现金 / 存款 | 手动录入 | 不变 |

场外基金没有盘中实时估值，是监管要求导致的公开数据限制；App 中会标注净值日期，不会伪造盘中变化。总资产会随股票部分实时变化。

## AI 截图导入

持仓很多时，不用一个个手输：

1. 打开 **添加资产 → AI 截图导入**（或资产清单底部「截图识别」）。
2. 填一次智谱 API Key：在 [智谱 API Keys](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) 创建，Key 只保存在本机。
3. 选 1–6 张券商 / 支付宝 / 天天基金持仓截图，点「开始识别」。
4. AI 提取名称、代码、数量、成本后，先在核对页修改，再选择「合并同代码」或「清空后导入」。

默认模型是免费的 **GLM-4.6V-Flash**；复杂截图可在识别设置里换 GLM-5.3-Flash / GLM-4.6V。识别结果可能出错，导入前务必核对代码、数量和成本。

截图会发送给你配置的智谱服务，不经过本项目的服务器；API Key 和账本数据只存在手机浏览器。

## 数据安全

- 没有后端、没有账号、没有统计脚本。
- 持仓与金额只存在当前浏览器；清除浏览器数据会丢失，请在 **设置 → 数据备份** 定期导出 JSON。
- 行情请求只发送证券代码到 `qt.gtimg.cn` / `web.ifzq.gtimg.cn`，不发送你的数量、成本或总资产。
- AI 截图识别只在你主动点击时把截图发送给智谱；Key 保存在本机，不随备份导出。
- 本应用仅用于个人记账，不构成投资建议。

## 目录

```
index.html            页面结构
styles.css            设计系统与响应式样式
app.js                行情、计算、渲染、编辑、PWA 逻辑
manifest.webmanifest  PWA 清单
sw.js                 离线缓存
icons/                应用图标
assets/fonts/         Instrument Serif / IBM Plex Mono
```
