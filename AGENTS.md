# REST Client — 项目说明

## 项目概述

本项目是 [vscode-restclient](https://github.com/Huachao/vscode-restclient) 的 fork，在原版 REST Client 基础上增加了**牵牛花（QNH）环境切换**等美团内部定制功能。

核心能力：在 VS Code 编辑器中直接发送 HTTP 请求并查看响应，支持 `.http` / `.rest` 文件语法高亮、自动补全、变量系统、环境切换、代码片段生成等。

---

## 技术栈

| 维度 | 选型 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js (VS Code Extension Host) |
| 构建 | Webpack + ts-loader → `dist/extension.js` |
| 模块系统 | CommonJS |
| 目标平台 | VS Code Extension API (`vscode` module) |
| 语法高亮 | TextMate grammar (`syntaxes/http.tmLanguage.json`) |
| 代码规范 | TSLint (`tslint.json`) |

---

## 目录结构

```
src/
├── extension.ts                        # 入口：activate() 注册所有 controllers/providers
├── controllers/
│   ├── requestController.ts            # 发送/取消/重发请求
│   ├── historyController.ts            # 请求历史保存/清除
│   ├── codeSnippetController.ts        # 生成代码片段 / 复制为 cURL
│   ├── environmentController.ts        # 环境切换（原版）
│   ├── swaggerController.ts            # Swagger 导入
│   └── qnhController.ts                # ★ QNH 环境切换（自定义）
├── models/                             # 数据模型 / 配置 / 解析器
│   ├── configurationSettings.ts        # SystemSettings — 所有配置项的单体
│   ├── httpRequest.ts / httpResponse.ts
│   ├── requestParser.ts / requestParserFactory.ts
│   └── ...                             # 其他模型
├── providers/                          # VS Code 语言功能注册
│   ├── httpCompletionItemProvider.ts   # 自动补全
│   ├── httpCodeLensProvider.ts         # CodeLens（Send Request 链接）
│   ├── httpDocumentSymbolProvider.ts   # 符号跳转
│   ├── requestVariableHoverProvider.ts # 变量悬停提示
│   └── ...                             # 其他 provider
├── utils/
│   ├── qnhClient.ts                    # ★ QNH HTTP 客户端（调 alfred proxy）
│   ├── qnhStatusBarEntry.ts            # ★ QNH 状态栏
│   ├── variableProcessor.ts            # 变量解析引擎
│   ├── httpClient.ts                   # 实际发送 HTTP 请求
│   ├── auth/                           # 认证（Basic/Digest/AAD/AWS/OIDC）
│   └── ...                             # 其他工具
├── views/                              # Webview 面板（响应预览、代码片段）
└── common/
    └── constants.ts                    # 常量（含 QNH 域名模板、变量名等）
```

---

## 自定义功能（美团内部）

### QNH 环境切换

允许在 `.http` 文件中通过 `{{qnh-host}}` / `{{qnh-cookie}}` / `{{qnh-tenant-id}}` / `{{qnh-account-id}}` 引用牵牛花环境。

| 环境 | Host |
|------|------|
| prod | `https://qnh.meituan.com` |
| staging | `https://qnh.shangou.st.meituan.com` |
| default | `https://qnh.shangou.test.meituan.com` |
| swimlane | `https://{value}-sl-qnh.shangou.test.meituan.com` |

**数据流：**
1. 用户执行 `rest-client.switch-qnh-environment` 命令
2. QuickPick 选择环境（swimlane 需额外选择/输入泳道值）
3. 通过本地 alfred proxy-server 抓取 Chrome cookie
4. 调用 `/api/v1/isLogined` 验证 cookie 并获取租户/用户信息
5. 写入 `rest-client.environmentVariables.$shared` 环境变量
6. 状态栏更新，`.http` 文件中变量自动解析

**关键文件：**
- `src/controllers/qnhController.ts` — 切换逻辑
- `src/utils/qnhClient.ts` — alfred HTTP 客户端
- `src/utils/qnhStatusBarEntry.ts` — 状态栏
- `src/common/constants.ts` — QNH 常量（域名模板、变量名）
- `docs/superpowers/specs/2026-08-14-qnh-environment-switching-design.md` — 设计文档

### 其他自定义功能

- **Cookie Jar** — 通过 `# @cookie-jar` 注释按需启用 cookie 持久化
- **Response Panel 增强** — JSON 搜索（key/value/mixed）、JSONPath 提取、管道注释、自定义主题模式
- **变量增强** — `{{@name}}` jq -R 转义语法支持

---

## 构建与开发

```bash
# 安装依赖
npm install

# 开发模式（webpack watch）
npm run watch

# 编译
npm run compile

# 打包 vsix
npm run package
```

按 `F5` 启动 Extension Development Host 进行调试。

---

## 代码规范

- TSLint 规则：`tslint.json`
  - 强制 `prefer-const`、`triple-equals`、`semicolon`
  - 强制 `ordered-imports`（import 排序）
  - 禁止 `no-console: log`、`no-var-keyword`
  - 强制 `no-trailing-whitespace`、`no-unused-expression`
- TypeScript 严格模式：`strictNullChecks`、`noUnusedLocals`
- 装饰器：`experimentalDecorators` 已启用（用于 `@trace` 性能追踪）

---

## 变量系统

变量通过 `variableProcessor.ts` 解析，支持四种类型：

| 类型 | 示例 | 说明 |
|------|------|------|
| 环境变量 | `{{qnh-host}}` | 来自 `rest-client.environmentVariables` |
| 文件变量 | `@name = value` | 定义在 `.http` 文件顶部 |
| 请求变量 | `@name = value` | 定义在请求前（`# @name`） |
| 系统变量 | `{{$guid}}` | 内置动态值（timestamp/random/datetime 等） |

变量可在 URL、Headers、Body 任意位置使用。

---

## 配置项

所有配置在 `package.json` → `contributes.configuration` 中声明，通过 `SystemSettings` 单体类读取。

关键配置：
- `rest-client.environmentVariables` — 环境变量定义
- `rest-client.qnh.alfredBaseUrl` — QNH alfred proxy 地址（默认 `http://localhost:8080`）
- `rest-client.timeoutInMilliseconds` — 请求超时
- `rest-client.previewResponseInUntitledDocument` — 在无标题文档中预览响应

---

## 注意事项

1. **QNH 功能依赖本地 alfred proxy-server**，未运行时 cookie 抓取会失败（host 仍正常切换）
2. **swimlane 环境**的 host 模板为 `{value}-sl-qnh.shangou.test.meituan.com`，value 来自 alfred 字典或手动输入
3. **环境变量写入 `$shared`**，因此在所有环境和「无环境」状态下都可使用
4. **激活时自动恢复**上次 QNH 环境（从 globalState 读取，重新抓取 cookie + 验证）
5. 本项目使用 `npm`（有 `package-lock.json`），非 `pnpm`
