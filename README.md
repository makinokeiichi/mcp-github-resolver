# mcp-github-resolver

GitHub Pull Request上の「会話（Review Threads）」を操作するためのMCP (Model Context Protocol) サーバー

## 概要

このMCPサーバーは、GitHub Pull Requestの未解決のレビュー会話を取得し、解決するための機能を提供します。
Cursorなどのエディタと統合することで、「PRの未解決コメントを解決して」といった自然な指示が可能になります。

## 機能

### 1. `get_unresolved_threads`
指定したPull Requestの未解決レビュースレッドの一覧を取得します。


**注意:** 取得できるレビュースレッドは最大100件までです。Pull Requestに100件を超えるスレッドが存在する場合、最初の100件のみが取得されます。すべての未解決会話が表示されない可能性があります。

**パラメータ:**
- `owner`: リポジトリオーナー名
- `repo`: リポジトリ名
- `pullRequestNumber`: Pull Request番号

**返り値:**
```json
{
  "count": 2,
  "threads": [
    {
      "id": "PRRT_...",
      "firstComment": {
        "author": "username",
        "body": "コメント内容"
      }
    }
  ]
}
```

### 2. `resolve_conversation`
指定したスレッドIDの会話を解決済みにします。

**パラメータ:**
- `threadId`: GraphQL Node ID (例: `PRRT_...`)

**返り値:**
```json
{
  "success": true,
  "threadId": "PRRT_...",
  "isResolved": true
}
```

### 3. `reply_to_thread`
指定されたプルリクエストの会話スレッドに返信コメントを追加します。

**パラメータ:**
- `threadId`: GraphQL Node ID (例: `PRRT_...`)
- `body`: 返信するコメントの本文

**返り値:**
```json
{
  "success": true,
  "commentUrl": "https://github.com/..."
}
```

## セットアップ

### 1. インストール

```bash
npm install
```

### 2. ビルド

```bash
npm run build
```

これにより、`dist/index.js` にトランスパイルされたファイルが生成されます。

### 3. GitHub トークンの設定

GitHub Personal Access Tokenが必要です。操作ごとに必要なスコープは以下の通りです：
- `get_unresolved_threads`（未解決スレッドの取得）: パブリックリポジトリの場合は `read:repo` または `repo:status`。プライベートリポジトリの場合は `repo` スコープが必要です。
- `resolve_conversation`（スレッドの解決）: `repo`（リポジトリへのフルアクセス）が必要です
- `reply_to_thread`（スレッドへの返信）: `repo`（リポジトリへのフルアクセス）が必要です

より限定的な権限で運用したい場合は、パブリックリポジトリの読み取り専用操作には `read:repo` などを利用できます。プライベートリポジトリや両方の操作を行う場合は `repo` スコープが必要です。
トークンは環境変数 `GITHUB_TOKEN` として設定します。

## Cursorでの設定方法

### Settings > Features > MCP への設定

Cursorの設定ファイル（`~/.cursor/config.json` または設定画面）に以下を追加してください：

**⚠️ 重要: `args` には `dist/index.js` への絶対パスを指定する必要があります**

```json
{
  "mcpServers": {
    "github-resolver": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-github-resolver/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "your_personal_access_token_here"
      }
    }
  }
}
```

### 設定例

```json
{
  "mcpServers": {
    "github-resolver": {
      "command": "node",
      "args": ["/Users/username/projects/mcp-github-resolver/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## 使い方

CursorのComposerやChatで、以下のように指示できます：

```
このPRの未解決のレビューコメントを全て解決してください
```

内部的には、以下のような処理が実行されます：

1. `get_unresolved_threads` で未解決スレッドを取得
2. 各スレッドに対して `resolve_conversation` を実行

## 技術スタック

- **Language:** TypeScript
- **Runtime:** Node.js
- **主要ライブラリ:**
  - `@modelcontextprotocol/sdk` - MCP SDK
  - `@octokit/graphql` - GitHub GraphQL API クライアント
  - `zod` - スキーマバリデーション
  - `dotenv` - 環境変数管理

## 開発

### ディレクトリ構成

```
mcp-github-resolver/
├── src/
│   └── index.ts          # メインエントリポイント
├── dist/                 # ビルド成果物（npm run build で生成）
│   └── index.js
├── package.json
├── tsconfig.json
└── README.md
```

### ビルド

```bash
npm run build
```

TypeScriptコードが `dist/` ディレクトリにトランスパイルされます。

## ライセンス

[ISC](/LICENSE)
