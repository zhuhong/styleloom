import { renderMarkdown } from "../lib/markdown";

type MarkdownProps = {
  content: string;
  projectId?: string;
};

export function Markdown({ content, projectId }: MarkdownProps) {
  // 外层 bubble 已带 .markdown；这里只注入安全 HTML。
  // display:contents 让内部块级元素（p/ul/pre）直接参与 bubble 排版。
  return (
    <span
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content, projectId) }}
    />
  );
}