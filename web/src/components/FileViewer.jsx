import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

export default function FileViewer({ content }) {
  if (!content) return <p className="empty">No content</p>;
  return (
    <div className="file-viewer">
      <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown>
    </div>
  );
}
