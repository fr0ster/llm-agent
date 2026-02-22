import type {
  CallOptions,
  ClassifierError,
  Result,
  Subprompt,
} from './types.js';

export interface ISubpromptClassifier {
  classify(
    text: string,
    options?: CallOptions,
  ): Promise<Result<Subprompt[], ClassifierError>>;
}
