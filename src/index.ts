#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
  console.error("Error: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

// GraphQLクライアントの初期化
const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

// get_unresolved_threads 用スキーマ
const GetUnresolvedThreadsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pullRequestNumber: z.number().describe("Pull request number"),
});

// resolve_conversation 用スキーマ
const ResolveConversationSchema = z.object({
  threadId: z.string().describe("Thread ID (GraphQL Node ID)"),
});

// reply_to_thread 用スキーマ
const ReplyToThreadSchema = z.object({
  threadId: z.string().describe("Thread ID (GraphQL Node ID)"),
  body: z.string().describe("返信するコメントの本文"),
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
    };
  };
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
const server = new Server(
  {
    name: "mcp-github-resolver",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ログ出力用のヘルパー関数
function log(message: string, ...args: any[]) {
  if (process.env.DEBUG === "true") {
    console.error(`[mcp-github-resolver] ${message}`, ...args);
  }
}

// 利用可能なツールのリスト
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_unresolved_threads",
        description:
          "指定したプルリクエストの未解決の会話スレッド一覧を取得します",
        inputSchema: {
          type: "object",
          properties: {
            owner: {
              type: "string",
              description: "リポジトリオーナー",
            },
            repo: {
              type: "string",
              description: "リポジトリ名",
            },
            pullRequestNumber: {
              type: "number",
              description: "プルリクエスト番号",
            },
          },
          required: ["owner", "repo", "pullRequestNumber"],
        },
      },
      {
        name: "resolve_conversation",
        description: "特定のスレッドIDを指定して会話を解決済みにします",
        inputSchema: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: "スレッドID (GraphQL Node ID)",
            },
          },
          required: ["threadId"],
        },
      },
      {
        name: "reply_to_thread",
        description:
          "指定されたプルリクエストの会話スレッドに返信コメントを追加します",
        inputSchema: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: "スレッドID (GraphQL Node ID)",
            },
            body: {
              type: "string",
              description: "返信するコメントの本文",
            },
          },
          required: ["threadId", "body"],
        },
      },
    ],
  };
});

// ツール呼び出しの処理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_unresolved_threads") {
    const { owner, repo, pullRequestNumber } =
      GetUnresolvedThreadsSchema.parse(args);

    const response = (await graphqlWithAuth(GET_UNRESOLVED_THREADS_QUERY, {
      owner,
      repo,
      pullRequestNumber,
    })) as GetUnresolvedThreadsResponse;

    if (!response.repository) {
      throw new Error("リポジトリが見つかりません");
    }
    if (!response.repository.pullRequest) {
      throw new Error("プルリクエストが見つかりません");
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
  } else if (name === "resolve_conversation") {
    const { threadId } = ResolveConversationSchema.parse(args);

    const response = (await graphqlWithAuth(RESOLVE_THREAD_MUTATION, {
      threadId,
    })) as ResolveThreadResponse;

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
  } else if (name === "reply_to_thread") {
    const { threadId, body } = ReplyToThreadSchema.parse(args);

    const response = (await graphqlWithAuth(ADD_REPLY_MUTATION, {
      threadId,
      body,
    })) as AddReplyResponse;

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
  } else {
    throw new Error(`不明なツール: ${name}`);
  }
});

// サーバーの起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP GitHub Resolver server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
