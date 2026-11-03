import type { ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import './Welcome.css';

const questions = [
  'BET 比表面积和 BJH 孔径分析有什么区别？',
  'Climber 测试前，应该准备哪些样品信息？',
  '如何参考历史案例设置压力程序与平衡条件？',
  '查询一下 Climber 当前的连接和运行状态。',
];
export function Welcome({
  composer,
  disabled,
  onQuestion,
}: {
  composer: ReactNode;
  disabled: boolean;
  onQuestion: (question: string) => void;
}) {
  return (
    <section className="faq-card">
      <div className="landing-identity">
        <Avatar />
        <span>量仔 · 你的测样小助理</span>
      </div>
      <h1>随时可以开始。</h1>
      <p className="landing-subtitle">从一个问题开始，让实验思路更清晰。</p>
      {composer}
      <h2>常见问题</h2>
      <div className="faq-list">
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
