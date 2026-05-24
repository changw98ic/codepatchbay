import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import LogStream from './LogStream';

const subscribeCallbacks = {};

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (event, callback) => {
      subscribeCallbacks[event] = callback;
      return () => {
        delete subscribeCallbacks[event];
      };
    }
  })
}));

describe('LogStream', () => {
  beforeEach(() => {
    Object.keys(subscribeCallbacks).forEach(k => delete subscribeCallbacks[k]);
  });

  it('renders initial logs and supports splitting', () => {
    render(<LogStream project="test" initialLog={`line1
line2
line3`} />);
    expect(screen.getByText('line1')).toBeInTheDocument();
    expect(screen.getByText('line2')).toBeInTheDocument();
    expect(screen.getByText('line3')).toBeInTheDocument();
  });

  it('limits initial logs rendering to 150 items', () => {
    const longLog = Array.from({ length: 200 }, (_, i) => `log line ${i}`).join('\n');
    render(<LogStream project="test" initialLog={longLog} />);
    
    // The first 50 lines should be capped and omitted
    expect(screen.queryByText('log line 0')).not.toBeInTheDocument();
    expect(screen.queryByText('log line 49')).not.toBeInTheDocument();
    
    // The last 150 lines should be rendered
    expect(screen.getByText('log line 50')).toBeInTheDocument();
    expect(screen.getByText('log line 199')).toBeInTheDocument();
  });

  it('appends and caps log lines from websocket messages to 150 items', () => {
    const longLog = Array.from({ length: 150 }, (_, i) => `initial ${i}`).join('\n');
    render(<LogStream project="test" initialLog={longLog} />);
    
    expect(screen.getByText('initial 0')).toBeInTheDocument();
    
    // Push new log append message
    act(() => {
      if (subscribeCallbacks['log:append']) {
        subscribeCallbacks['log:append']({ project: 'test', entry: 'new websocket line' });
      }
    });
    
    // Line 0 should be popped off to maintain the 150 cap
    expect(screen.queryByText('initial 0')).not.toBeInTheDocument();
    expect(screen.getByText('initial 1')).toBeInTheDocument();
    expect(screen.getByText('new websocket line')).toBeInTheDocument();
  });

  it('clears log stream when clear button is clicked', () => {
    render(<LogStream project="test" initialLog={`line1
line2`} />);
    expect(screen.getByText('line1')).toBeInTheDocument();
    
    const clearBtn = screen.getByRole('button', { name: /Clear Logs/ });
    fireEvent.click(clearBtn);
    
    expect(screen.queryByText('line1')).not.toBeInTheDocument();
    expect(screen.getByText('No log entries')).toBeInTheDocument();
  });
});
