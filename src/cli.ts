#!/usr/bin/env node

/**
 * CLI Test Launcher for LLM Proxy
 *
 * Simple test launcher to test the agent with different LLM providers and MCP configurations.
 *
 * Usage:
 *   # Copy .env.template to .env and fill in your values
 *   cp .env.template .env
 *
 *   # Test with MCP (default)
 *   npm run dev
 *
 *   # Test LLM only (without MCP)
 *   npm run dev:llm
 *
 *   # Or with flag
 *   npm run dev -- --llm-only
 *
 *   # Or with environment variable
 *   export MCP_DISABLED=true
 *   npm run dev
 *
 * Environment variables (can be set in .env file or as environment variables):
 *   LLM_PROVIDER - Provider to use: openai (default), anthropic, deepseek, or ollama
 *
 *   For OpenAI:
 *     OPENAI_API_KEY - Required - OpenAI API key
 *     OPENAI_MODEL - Optional - Model name (default: gpt-4o-mini)
 *     OPENAI_ORG - Optional - OpenAI organization ID
 *     OPENAI_PRJ or OPENAI_PROJECT - Optional - OpenAI project ID
 *
 *   For Anthropic:
 *     LLM_PROVIDER=anthropic - Required - Set provider to anthropic
 *     ANTHROPIC_API_KEY - Required - Anthropic API key
 *     ANTHROPIC_MODEL - Optional - Model name (default: claude-3-5-sonnet-20241022)
 *
 *   For DeepSeek:
 *     LLM_PROVIDER=deepseek - Required - Set provider to deepseek
 *     DEEPSEEK_API_KEY - Required - DeepSeek API key
 *     DEEPSEEK_MODEL - Optional - Model name (default: deepseek-chat)
 *
 *   For Ollama:
 *     LLM_PROVIDER=ollama - Required - Set provider to ollama
 *     OLLAMA_ENDPOINT - Optional - Ollama endpoint (default: http://localhost:11434/v1/chat/completions)
 *     OLLAMA_MODEL - Optional - Model name (default: llama3.2)
 *
 *   MCP Configuration (for MCP mode):
 *     MCP_ENDPOINT - MCP server endpoint (default: http://localhost:4004/mcp/stream/http)
 *     MCP_DISABLED - Set to 'true' to test LLM only without MCP
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import {
  AnthropicAgent,
  AnthropicProvider,
  DeepSeekAgent,
  DeepSeekProvider,
  MCPClientWrapper,
  OpenAIAgent,
  OpenAIProvider,
  PromptBasedAgent,
} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file if it exists
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  config({ path: envPath });
  console.log('📄 Loaded configuration from .env file\n');
} else {
  console.log(
    '💡 Tip: Create .env file from .env.template for easier configuration\n',
  );
}

// Read package.json for version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
);

console.log(`🤖 LLM Proxy Test Launcher v${packageJson.version}\n`);

// Get configuration from environment
const llmProvider = process.env.LLM_PROVIDER || 'openai';
const mcpEndpoint =
  process.env.MCP_ENDPOINT || 'http://localhost:4004/mcp/stream/http';
const mcpDisabled =
  process.env.MCP_DISABLED === 'true' ||
  process.argv.includes('--llm-only') ||
  process.argv.includes('--no-mcp');

// Get test message from command line args or use default
// Filter out flags from message
const messageArgs = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'));
const testMessage =
  messageArgs[0] ||
  (mcpDisabled
    ? 'Hello! Can you introduce yourself?'
    : 'What tools are available?');

async function main() {
  try {
    console.log('📋 Configuration:');
    console.log(`   LLM Provider: ${llmProvider}`);
    if (mcpDisabled) {
      console.log(`   MCP: ❌ DISABLED (LLM only mode)`);
    } else {
      console.log(`   MCP Endpoint: ${mcpEndpoint}`);
    }
    console.log(`   Test Message: ${testMessage}`);

    // Show API key status (masked)
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;

    if (llmProvider === 'openai') {
      if (openaiKey) {
        const masked =
          openaiKey.substring(0, 7) +
          '...' +
          openaiKey.substring(openaiKey.length - 4);
        console.log(`   API Key: ${masked} ✅`);
      } else {
        console.log(`   API Key: ❌ NOT SET`);
      }
    } else if (llmProvider === 'anthropic') {
      if (anthropicKey) {
        const masked =
          anthropicKey.substring(0, 7) +
          '...' +
          anthropicKey.substring(anthropicKey.length - 4);
        console.log(`   API Key: ${masked} ✅`);
      } else {
        console.log(`   API Key: ❌ NOT SET`);
      }
    } else if (llmProvider === 'deepseek') {
      if (deepseekKey) {
        const masked =
          deepseekKey.substring(0, 7) +
          '...' +
          deepseekKey.substring(deepseekKey.length - 4);
        console.log(`   API Key: ${masked} ✅`);
      } else {
        console.log(`   API Key: ❌ NOT SET`);
      }
    }
    console.log();

    // Create LLM provider
    let llmProviderInstance:
      | OpenAIProvider
      | AnthropicProvider
      | DeepSeekProvider;

    switch (llmProvider.toLowerCase()) {
      case 'openai': {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY environment variable is required');
        }
        // Parse baseURL from endpoint (remove /chat/completions if present)
        let baseURL: string | undefined;
        if (process.env.OPENAI_ENDPOINT) {
          baseURL = process.env.OPENAI_ENDPOINT.replace(
            '/chat/completions',
            '',
          );
        }

        llmProviderInstance = new OpenAIProvider({
          apiKey,
          baseURL,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          organization: process.env.OPENAI_ORG,
          project: process.env.OPENAI_PROJECT || process.env.OPENAI_PRJ,
        });
        const orgInfo = process.env.OPENAI_ORG
          ? ` (org: ${process.env.OPENAI_ORG.substring(0, 8)}...)`
          : '';
        const projectInfo =
          process.env.OPENAI_PROJECT || process.env.OPENAI_PRJ
            ? ` (project: ${(process.env.OPENAI_PROJECT || process.env.OPENAI_PRJ)?.substring(0, 8)}...)`
            : '';
        console.log(`✅ Created OpenAI provider${orgInfo}${projectInfo}`);
        break;
      }

      case 'anthropic': {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new Error('ANTHROPIC_API_KEY environment variable is required');
        }
        llmProviderInstance = new AnthropicProvider({
          apiKey,
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        });
        console.log('✅ Created Anthropic provider');
        break;
      }

      case 'deepseek': {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
          throw new Error('DEEPSEEK_API_KEY environment variable is required');
        }
        // Parse baseURL from endpoint (remove /chat/completions if present)
        let baseURL: string | undefined;
        if (process.env.DEEPSEEK_ENDPOINT) {
          baseURL = process.env.DEEPSEEK_ENDPOINT.replace(
            '/chat/completions',
            '',
          );
        }

        llmProviderInstance = new DeepSeekProvider({
          apiKey,
          baseURL,
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        });
        console.log('✅ Created DeepSeek provider');
        break;
      }

      case 'ollama': {
        // Ollama provider not yet implemented, but mentioned in .env.template
        throw new Error(
          'Ollama provider is not yet implemented. Use: openai, anthropic, or deepseek',
        );
      }

      default:
        throw new Error(
          `Unsupported LLM provider: ${llmProvider}. Use: openai, anthropic, or deepseek`,
        );
    }

    // Create agent based on provider
    let agent: OpenAIAgent | AnthropicAgent | DeepSeekAgent | PromptBasedAgent;

    if (mcpDisabled) {
      // LLM-only mode - create agent without MCP
      console.log('⚠️  Running in LLM-only mode (MCP disabled)\n');

      // For LLM-only mode, we'll use a simple wrapper that doesn't require MCP
      // We'll call LLM provider directly
      console.log('✅ Created LLM provider (standalone mode)\n');

      // Process message directly with LLM provider
      console.log(`💬 Processing message with LLM: "${testMessage}"\n`);
      const startTime = Date.now();

      const messages = [{ role: 'user' as const, content: testMessage }];

      const llmResponse = await llmProviderInstance.chat(messages);
      const duration = Date.now() - startTime;

      console.log('📤 LLM Response:');
      console.log('─'.repeat(60));
      console.log(llmResponse.content);
      if (llmResponse.finishReason) {
        console.log(`\nFinish reason: ${llmResponse.finishReason}`);
      }
      console.log('─'.repeat(60));
      console.log(`\n⏱️  Duration: ${duration}ms\n`);

      console.log('✅ LLM-only test completed successfully!\n');
      process.exit(0);
    }

    // MCP mode - create agent with MCP client
    const mcpClient = new MCPClientWrapper({
      url: mcpEndpoint,
      headers: {
        Authorization: process.env.MCP_AUTH_HEADER || 'Basic YWxpY2U6',
        'X-SAP-Destination': process.env.SAP_DESTINATION || '',
      },
    });
    console.log('✅ Created MCP client\n');

    if (llmProviderInstance instanceof OpenAIProvider) {
      agent = new OpenAIAgent({
        llmProvider: llmProviderInstance,
        mcpClient,
      });
    } else if (llmProviderInstance instanceof AnthropicProvider) {
      agent = new AnthropicAgent({
        llmProvider: llmProviderInstance,
        mcpClient,
      });
    } else if (llmProviderInstance instanceof DeepSeekProvider) {
      agent = new DeepSeekAgent({
        llmProvider: llmProviderInstance,
        mcpClient,
      });
    } else {
      agent = new PromptBasedAgent({
        llmProvider: llmProviderInstance,
        mcpClient,
      });
    }

    console.log('✅ Created agent instance');
    console.log(`   Agent type: ${agent.constructor.name}\n`);

    // Connect to MCP
    console.log('🔌 Connecting to MCP server...');
    await agent.connect();
    console.log('✅ Connected to MCP server\n');

    // List available tools
    const tools = await mcpClient.listTools();
    console.log(`📦 Available tools: ${tools.length}`);
    if (tools.length > 0) {
      tools
        .slice(0, 5)
        .forEach((tool: { name?: string; description?: string }) => {
          console.log(
            `   - ${tool.name}: ${tool.description || 'No description'}`,
          );
        });
      if (tools.length > 5) {
        console.log(`   ... and ${tools.length - 5} more`);
      }
    }
    console.log();

    // Process message
    console.log(`💬 Processing message: "${testMessage}"\n`);
    const startTime = Date.now();

    const response = await agent.process(testMessage);

    const duration = Date.now() - startTime;

    console.log('📤 Response:');
    console.log('─'.repeat(60));
    if (response.error) {
      console.error(`❌ Error: ${response.error}`);
    } else {
      console.log(response.message);
    }
    console.log('─'.repeat(60));
    console.log(`\n⏱️  Duration: ${duration}ms\n`);

    // Show conversation history
    const history = agent.getHistory();
    console.log(`📜 Conversation history: ${history.length} messages\n`);

    console.log('✅ Test completed successfully!\n');

    process.exit(0);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('\n❌ Error:', errorMessage);
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    console.error('\n💡 Tips:');
    console.error('   - Make sure MCP server is running');
    console.error('   - Check environment variables (API keys, endpoints)');
    console.error('   - Verify MCP endpoint is accessible\n');
    process.exit(1);
  }
}

// Run main function
main();
