import type { ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import type { QuestionSuggestions } from '@auto-agent/desktop-protocol';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import './Welcome.css';

const defaultQuestions = [
  'BET 比表面积和 BJH 孔径分析有什么区别？',
  '准备 SAM 文件前，需要确认哪些样品和测试信息？',
  '如何根据材料与测试目标选择合适的测试模板？',
  '如何查询知识库并核对资料来源？',
];
export function Welcome({
  composer,
  disabled,
  connected,
  suggestions,
  loading,
  onQuestion,
}: {
  composer: ReactNode;
  disabled: boolean;
  connected: boolean;
  suggestions: QuestionSuggestions | null;
  loading: boolean;
  onQuestion: (question: string) => void;
}) {
  const questions =
    suggestions?.questions.length === 4
      ? suggestions.questions
      : connected && !suggestions
        ? []
        : defaultQuestions;
  return (
    <section className="faq-card">
      <div className="landing-identity">
        <Avatar />
        <span>量仔 · 你的测样小助理</span>
      </div>
      <h1>随时可以开始。</h1>
      <p className="landing-subtitle">从一个问题开始，让实验思路更清晰。</p>
      {composer}
      <h2>为你推荐</h2>
      <div className="faq-list" aria-busy={loading}>
        {questions.map((question) => (
          <Button
            variant="ghost"
            className="faq-item"
            key={question}
            disabled={disabled}
            onClick={() => onQuestion(question)}
          >
            <BookOpen size={16} />
            <span>{question}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}
