import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import PipelineStatus from '../components/PipelineStatus';
import FileViewer from '../components/FileViewer';
import LogStream from '../components/LogStream';

const TABS = ['context', 'tasks', 'inbox', 'outputs', 'log', 'decisions'];

export default function Project() {
  const { name } = useParams();
  const [project, setProject] = useState(null);
  const [tab, setTab] = useState('context');
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const { subscribe } = useWebSocket();

  const fetchProject = () => {
    fetch(`/api/projects/${name}`)
      .then((r) => r.json())
      .then((data) => { setProject(data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchProject(); }, [name]);

  const fetchFileList = (type) => {
    fetch(`/api/projects/${name}/${type}`)
      .then((r) => r.json())
      .then(setFiles)
      .catch(() => setFiles([]));
  };

  const fetchFile = (filePath) => {
    fetch(`/api/projects/${name}/files/${filePath}`)
      .then((r) => r.json())
      .then((data) => { setFileContent(data.content); setSelectedFile(filePath); })
      .catch(() => { setFileContent(null); setSelectedFile(null); });
  };

  useEffect(() => {
    if (tab === 'inbox' || tab === 'outputs') {
      fetchFileList(tab);
      setSelectedFile(null);
      setFileContent(null);
    }
  }, [tab, name]);

  // Real-time updates
  useEffect(() => {
    const unsub1 = subscribe('pipeline:update', (msg) => {
      if (msg.project === name) fetchProject();
    });
    const unsub2 = subscribe('file:modified', (msg) => {
      if (msg.project === name && selectedFile === msg.path) fetchFile(msg.path);
    });
    const unsub3 = subscribe('file:created', (msg) => {
      if (msg.project === name && (tab === 'inbox' || tab === 'outputs')) fetchFileList(tab);
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [subscribe, name, tab, selectedFile]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!project) return <div className="error">Project not found</div>;

  return (
    <div className="project-detail">
      <div className="project-header">
        <Link to="/">← Back</Link>
        <h2>{name}</h2>
        {project.pipelineState && <PipelineStatus state={project.pipelineState} />}
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {tab === 'context' && <FileViewer content={project.context} />}
        {tab === 'tasks' && <FileViewer content={project.tasks} />}
        {tab === 'decisions' && <FileViewer content={project.decisions} />}
        {tab === 'log' && <LogStream project={name} initialLog={project.log} />}
        {(tab === 'inbox' || tab === 'outputs') && (
          <div className="file-browser">
            <div className="file-list">
              {files.length === 0 ? (
                <p className="empty">No files</p>
              ) : (
                files.map((f) => (
                  <button
                    key={f}
                    className={`file-item ${selectedFile === `${tab}/${f}` ? 'active' : ''}`}
                    onClick={() => fetchFile(`${tab}/${f}`)}
                  >
                    {f}
                  </button>
                ))
              )}
            </div>
            {selectedFile && (
              <div className="file-preview">
                <h4>{selectedFile}</h4>
                <FileViewer content={fileContent} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
