import type { ILlm, IRequestLogger, ISubpromptClassifier } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, ClassifierError, type Result, type Subprompt } from '@mcp-abap-adt/llm-agent';
export declare const DEFAULT_CLASSIFIER_PROMPT = "You are a Semantic Intent Analyzer. Decompose the user message into logical tasks.\nFor each task, identify:\n  - \"type\": chat (greetings, simple questions, math), action (tasks requiring tools or execution).\n  - \"text\": the actual task description.\n  - \"context\": the domain of the task (e.g., \"sap-abap\", \"math\", \"general\").\n  - \"dependency\": \"independent\", \"sequential\" (must run after previous action), or an ID of a subprompt this one depends on.\n\nCRITICAL RULES:\n1. If a message contains multiple sequential steps (e.g., \"Do A and then check B\"), SPLIT them into separate \"action\" subprompts with \"dependency\": \"sequential\" on the later steps.\n2. If tasks are independent (e.g., \"Check weather AND add 5+5\"), SPLIT them with \"dependency\": \"independent\".\n3. If a task is an atomic operation with a conditional fallback (e.g., \"Do A, if it fails do B\"), keep it as a SINGLE subprompt \u2014 the fallback is part of the same instruction.\n4. Be strictly neutral. Only assign \"sap-abap\" context if SAP terms are present.\n\nExample: \"Read table T100 and check its transport history. Also tell me a joke.\"\nResult: [\n  {\"type\": \"action\", \"text\": \"Read content of table T100\", \"context\": \"sap-abap\", \"dependency\": \"independent\"},\n  {\"type\": \"action\", \"text\": \"Check transport history of table T100\", \"context\": \"sap-abap\", \"dependency\": \"sequential\"},\n  {\"type\": \"chat\", \"text\": \"Tell a joke\", \"context\": \"general\", \"dependency\": \"independent\"}\n]\n\nReturn ONLY a JSON array.";
export interface LlmClassifierConfig {
    /** Override default system prompt. */
    systemPrompt?: string;
    /** Prompt version tag logged for observability. Default: 'v1'. */
    promptVersion?: string;
    /** Cache results for identical input text within the instance lifetime. Default: true. */
    enableCache?: boolean;
}
export declare class LlmClassifier implements ISubpromptClassifier {
    private readonly llm;
    private readonly requestLogger?;
    private readonly systemPrompt;
    private readonly cache;
    constructor(llm: ILlm, config?: LlmClassifierConfig, requestLogger?: IRequestLogger | undefined);
    classify(text: string, options?: CallOptions): Promise<Result<Subprompt[], ClassifierError>>;
}
//# sourceMappingURL=llm-classifier.d.ts.map