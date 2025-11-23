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

// Load environment variables
dotenv.config();

// Validate GitHub token
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

// Initialize GraphQL client
const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

// Schema for get_unresolved_threads
const GetUnresolvedThreadsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pullRequestNumber: z.number().describe("Pull request number"),
});

// Schema for resolve_conversation
const ResolveConversationSchema = z.object({
  threadId: z.string().describe("Thread ID (GraphQL Node ID)"),
});

// TypeScript interfaces for GraphQL responses
interface CommentNode {
  body: string;
  author: {
    login: string;
  };
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

// GraphQL query to get unresolved review threads
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

// GraphQL mutation to resolve a review thread
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

// Create MCP server
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_unresolved_threads",
        description:
          "Get a list of unresolved conversation threads for a specific pull request",
        inputSchema: {
          type: "object",
          properties: {
            owner: {
              type: "string",
              description: "Repository owner",
            },
            repo: {
              type: "string",
              description: "Repository name",
            },
            pullRequestNumber: {
              type: "number",
              description: "Pull request number",
            },
          },
          required: ["owner", "repo", "pullRequestNumber"],
        },
      },
      {
        name: "resolve_conversation",
        description: "Resolve a specific conversation thread by its ID",
        inputSchema: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: "Thread ID (GraphQL Node ID)",
            },
          },
          required: ["threadId"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_unresolved_threads") {
      const { owner, repo, pullRequestNumber } =
        GetUnresolvedThreadsSchema.parse(args);

      const response: GetUnresolvedThreadsResponse = await graphqlWithAuth(GET_UNRESOLVED_THREADS_QUERY, {
        owner,
        repo,
        pullRequestNumber,
      });

      const reviewThreads = response.repository.pullRequest.reviewThreads.nodes;
      const unresolvedThreads = reviewThreads
        .filter((thread: ReviewThreadNode) => !thread.isResolved)
        .map((thread: ReviewThreadNode) => ({
          id: thread.id,
          firstComment: thread.comments.nodes[0]
            ? {
                author: thread.comments.nodes[0].author.login,
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

      const response: ResolveThreadResponse = await graphqlWithAuth(RESOLVE_THREAD_MUTATION, {
        threadId,
      });

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
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP GitHub Resolver server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
