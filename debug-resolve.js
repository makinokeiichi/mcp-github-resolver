
import { graphql } from "@octokit/graphql";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN is not set");
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

const THREAD_IDS = [
  "PRRT_kwDOQbn4J85jNdbR",
  "PRRT_kwDOQbn4J85jNdbf",
  "PRRT_kwDOQbn4J85jNdbn"
];

async function resolveThread(threadId) {
  console.log(`Resolving thread ${threadId}...`);
  try {
    const result = await graphqlWithAuth(`
      mutation($threadId: ID!) {
        resolveReviewThread(input: {threadId: $threadId}) {
          thread {
            id
            isResolved
          }
        }
      }
    `, { threadId });
    console.log(`✅ Success: ${result.resolveReviewThread.thread.id} isResolved=${result.resolveReviewThread.thread.isResolved}`);
  } catch (error) {
    console.error(`❌ Failed: ${error.message}`);
    // console.error(JSON.stringify(error, null, 2));
  }
}

async function main() {
  for (const id of THREAD_IDS) {
    await resolveThread(id);
  }
}

main();

