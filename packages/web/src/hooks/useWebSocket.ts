'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

type MessageHandler = (data: any) => void;

function apiWebSocketUrl(endpoint: string): string {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
  try {
    const u = new URL(base);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = (u.pathname || '').replace(/\/$/, '');
    return `${proto}//${u.host}${path}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  } catch {
    return `ws://localhost:3001/api${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  }
}

export function useWebSocket(endpoint: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const [isConnected, setIsConnected] = useState(false);
  const handlersRef = useRef<Map<string, MessageHandler[]>>(new Map());

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const wsUrl = apiWebSocketUrl(endpoint);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`WebSocket connected to ${endpoint}`);
      setIsConnected(true);
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      console.log(`WebSocket disconnected from ${endpoint}`);
      setIsConnected(false);

      if (!shouldReconnectRef.current) return;

      // Reconnect after a short delay if the component is still mounted.
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const handlers = handlersRef.current.get(message.type) || [];
        handlers.forEach(handler => handler(message.data));
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    wsRef.current = ws;
  }, [endpoint]);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const subscribe = useCallback((type: string, handler: MessageHandler) => {
    const handlers = handlersRef.current.get(type) || [];
    handlers.push(handler);
    handlersRef.current.set(type, handlers);

    return () => {
      const handlers = handlersRef.current.get(type) || [];
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    };
  }, []);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    isConnected,
    subscribe,
    disconnect,
    reconnect: connect,
  };
}

// Hook specifically for scan progress
export function useScanProgress(onProgress: (progress: any) => void) {
  const { subscribe, isConnected } = useWebSocket('/scan/ws');

  useEffect(() => {
    return subscribe('scan_progress', onProgress);
  }, [subscribe, onProgress]);

  return { isConnected };
}

// Hook specifically for action progress
export function useActionProgress(onProgress: (progress: any) => void) {
  const { subscribe, isConnected } = useWebSocket('/actions/ws');

  useEffect(() => {
    return subscribe('action_progress', onProgress);
  }, [subscribe, onProgress]);

  return { isConnected };
}
