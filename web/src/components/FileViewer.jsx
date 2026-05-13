import React from 'react';
import ReactMarkdown from 'react-markdown';

export default function FileViewer({ content }) {
  if (!content) return <p className="empty">No content</p>;
  return (
    <div className="file-viewer">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
