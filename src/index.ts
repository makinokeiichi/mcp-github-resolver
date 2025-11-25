#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { graphql } from "@octokit/graphql";
import { z } from "zod";
import dotenv from "dotenv";

// 環境変数の読み込み（ローカル開発用）
// MCPサーバーとして実行される際は、ホストアプリケーションから環境変数が提供されることを想定
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// GitHubトークンの検証
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error(
    "Error: GITHUB_TOKEN environment variable is required / GITHUB_TOKEN環境変数が必要です"
  );
  process.exit(1);
}

// GitHubトークンの形式チェック（基本的な検証）
if (!GITHUB_TOKEN.match(/^(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36}$/)) {
  console.error(
    "Error: GITHUB_TOKEN format is invalid. Expected format: <prefix>_<36 alphanumeric chars> (e.g., ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx). " +
      "See https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token for details. " +
      "GITHUB_TOKENの形式が無効です。例: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  );
  process.exit(1);
}

// GraphQLクライアントの初期化
const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

// GraphQLレスポンスの型定義
interface CommentNode {
  body: string;
  author: {
    login: string;
  } | null;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: CommentNode[];
  };
}

interface GetUnresolvedThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ReviewThreadNode[];
      };
    } | null;
  } | null;
}

interface ResolveThreadResponse {
  resolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
    };
  };
}

interface AddReplyResponse {
  addPullRequestReviewThreadReply: {
    comment: {
      url: string;
    };
  };
}

// 未解決レビュースレッドを取得するGraphQLクエリ
const GET_UNRESOLVED_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullRequestNumber) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes {
                body
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`;

// レビュースレッドを解決するGraphQLミューテーション
const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread {
        id
        isResolved
      }
    }
  }
`;

// スレッドに返信するGraphQLミューテーション
const ADD_REPLY_MUTATION = `
  mutation AddReply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
      comment {
        url
      }
    }
  }
`;

// MCPサーバーの作成
const server = new McpServer({
  name: "mcp-github-resolver",
  version: "1.1.0",
});

// ログ出力用のヘルパー関数
function log(message: string, ...args: any[]) {
  if (process.env.DEBUG === "true") {
    console.error(`[mcp-github-resolver] ${message}`, ...args);
  }
}

function logError(message: string, error: unknown) {
  console.error(`[mcp-github-resolver] ERROR: ${message}`, error);
}

/**
 * GraphQLリクエストのラッパー関数（エラーハンドリング付き）
 * @template T - レスポンスデータの型
 * @param {string} query - GraphQLクエリまたはミューテーション文字列
 * @param {Record<string, any>} variables - GraphQLクエリに渡す変数オブジェクト
 * @returns {Promise<T>} GraphQL APIからのレスポンスデータ
 * @throws {Error} 認証エラー、リソース未検出エラー、その他のGraphQLエラー
 * 
 * @example
 * ```typescript
 * const response = await graphqlRequest<GetUnresolvedThreadsResponse>(
 *   GET_UNRESOLVED_THREADS_QUERY,
 *   { owner: "octocat", repo: "Hello-World", pullRequestNumber: 1 }
 * );
 * ```
 * 
 * @remarks
 * @octokit/graphqlは直接データを返すが、エラー時は例外をスローする。
 * この関数はエラーをキャッチし、より分かりやすいエラーメッセージを提供する。
 */
async function graphqlRequest<T>(
  query: string,
  variables: Record<string, any>
): Promise<T> {
  try {
    const response = (await graphqlWithAuth(query, variables)) as T;
    return response;
  } catch (error) {
    if (error instanceof Error) {
      logError("GraphQL request failed", error);
      // エラーメッセージを改善
      // Note: 文字列マッチングを使用しているが、@octokit/graphqlのエラーオブジェクトには
      // 標準的なエラーコードプロパティが存在しないため、メッセージ文字列での判定が一般的な方法。
      // より堅牢な方法としては、エラーオブジェクトの型定義を拡張してエラーコードを追加することも可能。
      if (error.message.includes("Bad credentials")) {
        throw new Error(
          `Authentication failed: Invalid GITHUB_TOKEN / 認証に失敗しました: GITHUB_TOKENが無効です`
        );
      }
      if (error.message.includes("Not Found")) {
        throw new Error(
          `Resource not found / リソースが見つかりません: ${error.message}`
        );
      }
      throw new Error(`GraphQL Error / GraphQLエラー: ${error.message}`);
    }
    throw new Error(`Unknown error / 不明なエラー: ${String(error)}`);
  }
}

// ツール: 未解決スレッドの取得
server.registerTool(
  "get_unresolved_threads",
  {
    description: "指定したプルリクエストの未解決の会話スレッド一覧を取得します",
    inputSchema: z.object({
      owner: z.string().describe("リポジトリオーナー"),
      repo: z.string().describe("リポジトリ名"),
      pullRequestNumber: z.number().describe("プルリクエスト番号"),
    }),
  },
  async ({ owner, repo, pullRequestNumber }) => {
    const response = await graphqlRequest<GetUnresolvedThreadsResponse>(
      GET_UNRESOLVED_THREADS_QUERY,
      {
        owner,
        repo,
        pullRequestNumber,
      }
    );

    if (!response.repository) {
      throw new Error(
        `Repository not found: ${owner}/${repo} / リポジトリが見つかりません: ${owner}/${repo}`
      );
    }
    if (!response.repository.pullRequest) {
      throw new Error(
        `Pull request not found: #${pullRequestNumber} / プルリクエストが見つかりません: #${pullRequestNumber}`
      );
    }

    const reviewThreads = response.repository.pullRequest.reviewThreads.nodes;
    const unresolvedThreads = reviewThreads
      .filter((thread) => !thread.isResolved)
      .map((thread) => ({
        id: thread.id,
        firstComment: thread.comments.nodes[0]
          ? {
              author: thread.comments.nodes[0].author?.login ?? "unknown",
              body: thread.comments.nodes[0].body,
            }
          : null,
      }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: unresolvedThreads.length,
              threads: unresolvedThreads,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ツール: スレッドの解決
server.registerTool(
  "resolve_conversation",
  {
    description: "特定のスレッドIDを指定して会話を解決済みにします",
    inputSchema: z.object({
      threadId: z.string().describe("スレッドID (GraphQL Node ID)"),
    }),
  },
  async ({ threadId }) => {
    const response = await graphqlRequest<ResolveThreadResponse>(
      RESOLVE_THREAD_MUTATION,
      {
        threadId,
      }
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              threadId: response.resolveReviewThread.thread.id,
              isResolved: response.resolveReviewThread.thread.isResolved,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ツール: スレッドへの返信
server.registerTool(
  "reply_to_thread",
  {
    description: "指定されたプルリクエストの会話スレッドに返信コメントを追加します",
    inputSchema: z.object({
      threadId: z.string().describe("スレッドID (GraphQL Node ID)"),
      body: z.string().describe("返信するコメントの本文"),
    }),
  },
  async ({ threadId, body }) => {
    const response = await graphqlRequest<AddReplyResponse>(
      ADD_REPLY_MUTATION,
      {
        threadId,
        body,
      }
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              commentUrl: response.addPullRequestReviewThreadReply.comment.url,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// サーバーの起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP GitHub Resolver server running on stdio");
}

main().catch((error) => {
  logError("Fatal error during server startup", error);
  process.exit(1);
});
