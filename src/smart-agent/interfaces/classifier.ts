import type {
  CallOptions,
  ClassifierError,
  ClassifierResult,
  Result,
} from './types.js';

export interface ISubpromptClassifier {
  classify(
    text: string,
    options?: CallOptions,
  ): Promise<Result<ClassifierResult, ClassifierError>>;
}
