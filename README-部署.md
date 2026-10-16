# 云服务器部署指南（Render 及同类平台）

## 前置条件
- 一个 GitHub 账号（github.com，免费注册）
- 一个 Render 账号（render.com，可用 GitHub 账号直接登录，免费）

## 部署步骤（Render）
1. **把本项目上传到 GitHub 仓库**（私有仓库即可）：
   - 本地仓库已初始化并完成首次提交（git log 可查看）；
   - 在 GitHub 新建空仓库后，执行：
     ```powershell
     cd "d:\外快\2\毕设归档系统"
     git remote add origin https://github.com/<你的用户名>/<仓库名>.git
     git push -u origin master
     ```
2. **Render 创建服务**：
   - 登录 render.com → New + → Web Service；
   - 连接刚建的 GitHub 仓库；
   - Render 会自动读取 `render.yaml`：Node 运行时、`npm install` 构建、`node server.js` 启动、Node 22.14.0；
   - 点 Create Web Service，等待 2~3 分钟完成部署；
   - 获得公网地址：`https://grad-archive-system-xxxx.onrender.com`，任何电脑/手机均可访问。
3. **更新代码**：本地改完 `git push` 后，Render 自动重新部署。

## ⚠️ 重要：免费版数据会丢失（必须阅读）
Render **免费套餐的磁盘是临时的**：每次重新部署或容器重启时，`data/archive.db` 会被重置——**不满足"记录永久保存"的要求**。三种解决办法：

| 方案 | 费用 | 永久保存 | 说明 |
|---|---|---|---|
| Render 付费持久磁盘 | 约 $7/月 | ✅ | render.yaml 加 `disk` 配置挂载 /opt/data，改环境变量 DATA_DIR |
| Railway / Fly.io 等带卷平台 | 低成本/试用额度 | ✅ | 同样需挂载持久卷 |
| 国内云服务器（腾讯/阿里轻量） | 约 ¥50~100/年 | ✅ 最稳 | 国内访问快、真 VPS、数据随机器；可用宝塔面板 + pm2 守护 |

## 数据库位置可配置
服务器已支持环境变量 `DATA_DIR` 指定数据库目录（便于挂载持久卷时把数据放到卷内）。未设置时默认使用项目内 `data/`。

## 平台无关说明
- 平台会注入 `PORT` 环境变量，服务器已自动使用（本地默认 3000）。
- 首次部署自动创建管理员 admin/admin123，请登录后尽快修改（当前版本修改密码请联系开发者，后续可加自助修改）。
- 教师账号由 Excel 导入自动创建，初始密码 123456。
