# QNH 环境切换 — 设计

## 目标
给 REST Client 增加牵牛花环境切换能力。切换 prod/staging/swimlane/default 后，自动注入 `qnh-host` 域名变量 + 抓取该域 Chrome cookie 注入 `qnh-cookie` 变量。变量可见可编辑，每次切换触发查询更新。业务在 `.http` 里按需引用 `{{qnh-host}}`/`{{qnh-cookie}}`。

## 架构
复用 REST Client 现有 Environments + 变量解析。`qnh-host`/`qnh-cookie` 作为普通环境变量写入 `rest-client.environmentVariables.qnh`，现有 `variableProcessor` 自动解析 `{{qnh-host}}`，**不改变量解析层、不新增系统变量提供器**。

## 域名
| 环境 | host |
|------|------|
| prod | https://qnh.meituan.com |
| staging | https://qnh.shangou.st.meituan.com |
| default lane | https://qnh.shangou.test.meituan.com |
| swimlane | https://{value}-sl-qnh.shangou.test.meituan.com（value 来自 alfred dict） |

## 组件（restclient 侧）
1. `constants.ts` — QNH host 模板、环境 key、变量名常量
2. `configurationSettings.ts` + `package.json` — `rest-client.qnh.alfredBaseUrl`（默认 `http://localhost:8080`）
3. `utils/qnhClient.ts` — 调 alfred：`GET /dictionaries?categoryKey=swimlane` 取列表、`GET /api/qnh/cookie?host={host}` 取 cookie
4. `utils/qnhStatusBarEntry.ts` — 状态栏显示当前 QNH 环境
5. `controllers/qnhController.ts` — QuickPick 切换 + 写环境变量 + 状态栏
6. `extension.ts` — 注册 `rest-client.switch-qnh-environment`
7. `package.json` — contributes.commands + configuration

## alfred 侧
`routes/qnh.js` 新增 `GET /cookie?host=xxx`，提取复用现有内部 `getChromeCookies`，返回 `{success, cookie}`。

## 数据流
切换命令 → QuickPick(prod/staging/swimlane/default) →
- swimlane：调 `/dictionaries?categoryKey=swimlane` → QuickPick(title→value) +「手动输入」→ 得 value
- 算 host（swimlane 拼 `{value}-sl-qnh...`，其余取固定域名）
→ 调 `/api/qnh/cookie?host={host}` 抓 Chrome cookie →
→ `workspace.getConfiguration('rest-client').update('environmentVariables.qnh', {host, cookie})` 写入 `qnh` 环境 →
→ 切到 `qnh` 环境 + 状态栏更新 →
→ `.http` 里 `{{qnh-host}}`/`{{qnh-cookie}}` 生效

## 错误处理
- alfred 没跑 / cookie 失败：`qnh-cookie` 置空 + 状态栏警告 + 通知；host 仍正常切换
- swimlane 列表查询失败：QuickPick 退化为只有「手动输入」
- 手动输入的 swimlane：直接当 value 拼 host，不校验存在性

## 测试
- host 模板单测（4 种环境拼域名）
- dict 列表解析单测（title/value 映射，mock alfred）
- 切换流程集成测（mock alfred HTTP，验证 settings 写入 + 变量解析）
