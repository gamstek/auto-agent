/** Advisory questions only; selecting one still uses ordinary chat admission. */
export interface QuestionSuggestions {
  questions: string[];
  source: 'model' | 'default';
  generatedAt?: string;
  message?: string;
}
