import {
  type IMcpFailureClassifier,
  isMcpUnavailable,
  type McpError,
  type McpFailureKind,
} from '@mcp-abap-adt/llm-agent';

/** Default classifier: error-based (isMcpUnavailable). Does NOT probe health —
 *  a consumer can implement a ping-confirming classifier via the probeHealth seam. */
export class DefaultMcpFailureClassifier implements IMcpFailureClassifier {
  async classify(error: McpError): Promise<McpFailureKind> {
    return isMcpUnavailable(error) ? 'unavailable' : 'tool-error';
  }
}
