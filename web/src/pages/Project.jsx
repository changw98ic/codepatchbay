import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import useCappedList from '../hooks/useCappedList';
import PipelineStatus from '../components/PipelineStatus';
import FileViewer from '../components/FileViewer';
import LogStream from '../components/LogStream';

const TABS = ['overview', 'tasks', 'knowledge', 'settings'];

export default function Project() {
  const { name } = useParams();
  const [project, setProject] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'overview';
  const selectedFile = searchParams.get('file') || null;

  const [fileType, setFileType] = useState('inbox');
  const [selectedTask, setSelectedTask] = useState(null);
  const [autoSync, setAutoSync] = useState(() => {
    try { return localStorage.getItem('cpb-settings-autoSync') !== 'false'; } catch { return true; }
  });
  const [writeback, setWriteback] = useState(() => {
    try { return localStorage.getItem('cpb-settings-writeback') === 'true'; } catch { return false; }
  });
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(() => {
    try { return localStorage.getItem('cpb-settings-diagnostics') === 'true'; } catch { return false; }
  });

  const toggleSetting = (key, current, setter) => {
    const next = !current;
    setter(next);
    try { localStorage.setItem(`cpb-settings-${key}`, String(next)); } catch {}
  };

  const setTab = (newTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      next.delete('file');
      return next;
    }, { replace: true });
  };

  const setSelectedFile = (newFile) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (newFile) {
        next.set('file', newFile);
      } else {
        next.delete('file');
      }
      return next;
    }, { replace: true });
  };

  const [files, setFiles] = useState([]);
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

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/projects/${name}/${fileType}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setFiles)
      .catch(() => setFiles([]));
    return () => controller.abort();
  }, [fileType, name]);

  useEffect(() => {
    const controller = new AbortController();
    if (selectedFile) {
      fetch(`/api/projects/${name}/files/${selectedFile}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => setFileContent(data.content))
        .catch(() => setFileContent(null));
    } else {
      setFileContent(null);
    }
    return () => controller.abort();
  }, [selectedFile, name]);

  const { displayed: displayFiles, showAll: showAllFiles, toggle: toggleFiles, hasMore: hasMoreFiles } = useCappedList(files, {
    cap: 5,
    selectedKey: selectedFile,
    keyFn: (f) => `${fileType}/${f}`,
    deps: [fileType],
  });

  useEffect(() => {
    const unsub1 = subscribe('pipeline:update', (msg) => {
      if (msg.project === name) {
        setProject((prev) => prev ? { ...prev, pipelineState: msg.state } : null);
      }
    });
    const unsub2 = subscribe('file:modified', (msg) => {
      if (msg.project === name && selectedFile === msg.path) {
        fetch(`/api/projects/${name}/files/${msg.path}`)
          .then((r) => r.json())
          .then((data) => setFileContent(data.content))
          .catch(() => {});
      }
    });
    const unsub3 = subscribe('file:created', (msg) => {
      if (msg.project === name) fetchFileList(fileType);
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [subscribe, name, fileType, selectedFile]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!project) return <div className="error">Project not found</div>;

  const parseTasksFromMarkdown = (markdown) => {
    if (!markdown) return [];
    const lines = markdown.split('\n');
    const list = [];
    lines.forEach((line, index) => {
      const match = line.match(/^\s*-\s*\[([ x/])\]\s*(.*)$/i);
      if (match) {
        const checked = match[1].toLowerCase();
        const title = match[2].trim();
        const state = checked === 'x' ? 'done' : checked === '/' ? 'in_progress' : 'open';
        const stateLabel = checked === 'x' ? 'Done' : checked === '/' ? 'In progress' : 'Open';
        list.push({
          id: `task-${index}`,
          title,
          state,
          stateLabel,
          checked: checked === 'x',
          sourceLine: index + 1,
          description: 'Parsed from project task markdown.'
        });
      }
    });
    return list;
  };

  const parsedTasks = parseTasksFromMarkdown(project.tasks);
  const tasksList = parsedTasks.length > 0 ? parsedTasks : [];
  const indexState = project.projectIndex?.state;
  const indexBranch = project.projectIndex?.branch;
  const indexReady = indexState === 'ready';

  const lanes = [
    { id: 'open', title: 'Open' },
    { id: 'in_progress', title: 'In Progress' },
    { id: 'done', title: 'Done' },
  ];

  return (
    <div className="project-detail animate-fade-in">
      <div className="project-header">
        <Link to="/" className="btn btn-secondary">← Back</Link>
        <h2>{name}</h2>
        {project.pipelineState && <PipelineStatus state={project.pipelineState} />}
        {project.projectIndex && (
          <span className={`badge badge-idx-${project.projectIndex.state}`}>
            idx:{project.projectIndex.state}
            {project.projectIndex.branch ? ` (${project.projectIndex.branch})` : ''}
          </span>
        )}
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            id={`tab-${t}`}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => {
              setTab(t);
              setSelectedTask(null);
            }}
            role="tab"
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            type="button"
          >
            {t}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {tab === 'overview' && (
          <div id="panel-overview" className="overview-tab-content" role="tabpanel" aria-labelledby="tab-overview">
            <div className="overview-grid">
              <section className="panel story-section">
                <h3>Project Narrative Summary</h3>
                <div className="overview-narrative">
                  {project.projectIndex ? (
                    <p>
                      <strong>{name}</strong> has codebase index data for the{' '}
                      <code>{indexBranch || 'unknown'}</code> branch. The indexing status is currently{' '}
                      <span className={`badge ${indexReady ? 'badge-success' : indexState === 'stale' ? 'badge-warning' : 'badge-running'} badge-uppercase`}>
                        {indexState || 'unknown'}
                      </span>.
                    </p>
                  ) : (
                    <p>
                      <strong>{name}</strong> does not have codebase index data available yet.
                    </p>
                  )}
                  <p>
                    The codebase features automated context tracking. There are{' '}
                    <strong>{files.length} active files</strong> currently listed in the inbox/outputs queue. Structural pollution and dependency blockade diagnostics are not reported by this view.
                  </p>
                </div>
              </section>

              <section className="panel arch-section">
                <h3>Codebase Index</h3>
                {project.projectIndex ? (
                  <div className="arch-info-grid">
                    <div className="arch-info-item">
                      <span className="arch-info-label">State</span>
                      <span className={`badge badge-${project.projectIndex.state === 'ready' ? 'success' : project.projectIndex.state === 'stale' ? 'warning' : 'running'}`}>
                        {project.projectIndex.state}
                      </span>
                    </div>
                    <div className="arch-info-item">
                      <span className="arch-info-label">Branch</span>
                      <code>{project.projectIndex.branch || 'unknown'}</code>
                    </div>
                    {project.projectIndex.fileCount != null && (
                      <div className="arch-info-item">
                        <span className="arch-info-label">Files indexed</span>
                        <span>{project.projectIndex.fileCount}</span>
                      </div>
                    )}
                    {project.projectIndex.symbolCount != null && (
                      <div className="arch-info-item">
                        <span className="arch-info-label">Symbols</span>
                        <span>{project.projectIndex.symbolCount}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted">No codebase index available. This project has not been indexed yet.</p>
                )}
              </section>
            </div>

            <section className="panel mt-24">
              <h3>Live Activity stream</h3>
              <LogStream project={name} initialLog={project.log} />
            </section>
          </div>
        )}

        {tab === 'tasks' && (
          <div id="panel-tasks" className="tasks-tab-content" role="tabpanel" aria-labelledby="tab-tasks">
            <div className="workflow-board">
              {lanes.map((lane) => {
                const laneTasks = tasksList.filter((t) => t.state === lane.id);
                return (
                  <div key={lane.id} className="workflow-lane">
                    <div className="lane-header">
                      <span>{lane.title}</span>
                      <span className="lane-count">{laneTasks.length}</span>
                    </div>
                    {laneTasks.map((task) => (
                      <div
                        key={task.id}
                        className={`workflow-card ${selectedTask?.id === task.id ? 'active' : ''}`}
                        onClick={() => setSelectedTask(task)}
                      >
                        <h5>{task.title}</h5>
                        <div className="task-meta">
                          <span>{task.stateLabel}</span>
                          <span>Line {task.sourceLine}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {selectedTask && (
              <div className="drilldown-pane">
                <div className="drilldown-header">
                  <h4>Task Detail: {selectedTask.title}</h4>
                  <button className="btn btn-secondary" onClick={() => setSelectedTask(null)}>Close</button>
                </div>
                <div className="drilldown-grid">
                  <div>
                    <p className="task-detail-desc">{selectedTask.description}</p>
                    <dl className="task-detail-dl">
                      <dt>Checklist state</dt>
                      <dd>{selectedTask.stateLabel}</dd>
                      <dt>Source line</dt>
                      <dd>{selectedTask.sourceLine}</dd>
                    </dl>
                  </div>
                </div>
              </div>
            )}

            <div className="panel mt-32">
              <h3>Generated Deliverables & Inbox Files</h3>
              <div className="file-browser-tabs">
                <button
                  className={`file-browser-tab ${fileType === 'inbox' ? 'active' : ''}`}
                  onClick={() => setFileType('inbox')}
                  type="button"
                >
                  Inbox Files
                </button>
                <button
                  className={`file-browser-tab ${fileType === 'outputs' ? 'active' : ''}`}
                  onClick={() => setFileType('outputs')}
                  type="button"
                >
                  Output Files
                </button>
              </div>
              <div className="file-browser">
                <div className="file-browser-body">
                  <div className="file-list">
                    {files.length === 0 ? (
                      <p className="empty">No files in {fileType}</p>
                    ) : (
                      displayFiles.map((f) => (
                        <button
                          key={f}
                          className={`file-item ${selectedFile === `${fileType}/${f}` ? 'active' : ''}`}
                          onClick={() => setSelectedFile(`${fileType}/${f}`)}
                          type="button"
                        >
                          {f}
                        </button>
                      ))
                    )}
                  </div>
                  {hasMoreFiles && (
                    <div className="show-more-container">
                      <button
                        className="show-more-btn show-more-btn-full"
                        onClick={toggleFiles}
                        type="button"
                      >
                        {showAllFiles ? '▲ Show Less Files' : `▼ Show All Files (${files.length})`}
                      </button>
                    </div>
                  )}
                </div>
                {selectedFile && (
                  <div className="file-preview">
                    <h4>{selectedFile}</h4>
                    <FileViewer content={fileContent} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'knowledge' && (
          <div id="panel-knowledge" className="knowledge-tab-content" role="tabpanel" aria-labelledby="tab-knowledge">
            <section className="panel">
              <h3>Knowledge Base</h3>
              <p className="muted">
                {project.context || project.decisions
                  ? 'Project knowledge documents are available below.'
                  : 'No knowledge documents found for this project.'}
              </p>
            </section>

            <div className="knowledge-grid">
              <section className="panel">
                <h3>Project Context</h3>
                <FileViewer content={project.context} />
              </section>
              <section className="panel">
                <h3>Decision Ledger</h3>
                <FileViewer content={project.decisions} />
              </section>
            </div>
          </div>
        )}

        {tab === 'settings' && (
          <div id="panel-settings" className="settings-tab-content" role="tabpanel" aria-labelledby="tab-settings">
            <div className="settings-panel">
              <div className="settings-row">
                <div className="settings-info">
                  <h4>Auto-Sync Codebase Index</h4>
                  <p>Automatically sync structural symbol indices on local file change detection.</p>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={autoSync} onChange={() => toggleSetting('autoSync', autoSync, setAutoSync)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-info">
                  <h4>Permit Git Writeback Commits</h4>
                  <p>Allow the AI agent to commit and push approved files back to remote branches.</p>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={writeback} onChange={() => toggleSetting('writeback', writeback, setWriteback)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-info">
                  <h4>Enhanced Diagnostics Mode</h4>
                  <p>Output verbose structural debugger details and environment trace logs to console.</p>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={diagnosticsEnabled} onChange={() => toggleSetting('diagnostics', diagnosticsEnabled, setDiagnosticsEnabled)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
