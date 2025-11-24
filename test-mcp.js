import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, 'dist/index.js');

console.log(`Starting MCP server from ${distPath}...`);

const server = spawn('node', [distPath], {
  env: process.env
});

let buffer = '';

server.stdout.on('data', (data) => {
  const chunk = data.toString();
  buffer += chunk;
  const lines = buffer.split('\n');
  
  // Keep the last partial line in the buffer
  if (!chunk.endsWith('\n')) {
      buffer = lines.pop() || '';
  } else {
      buffer = '';
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      console.log('Non-JSON output:', line);
    }
  }
});

server.stderr.on('data', (data) => {
  console.error(`Server Log: ${data}`);
});

server.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
});

function send(msg) {
  server.stdin.write(JSON.stringify(msg) + '\n');
}

function handleMessage(msg) {
  if (msg.id === 1 && msg.result) {
    console.log('✅ Initialized. Fetching threads for PR #2...');
    send({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_unresolved_threads',
        arguments: {
          owner: 'makinokeiichi',
          repo: 'mcp-github-resolver',
          pullRequestNumber: 2
        }
      }
    });
  } else if (msg.id === 2) {
    if (msg.error) {
        console.error('❌ Tool Error:', msg.error);
    } else {
        console.log('✅ Tool Result:', JSON.stringify(JSON.parse(msg.result.content[0].text), null, 2));
    }
    process.exit(0);
  }
}

// Start handshake
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
});

