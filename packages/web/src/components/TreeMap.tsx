'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as d3 from 'd3';
import { ChevronLeft, Home, ExternalLink } from 'lucide-react';
import { filesApi, formatBytes, DriveFile } from '@/lib/api';

interface TreemapFile extends DriveFile {
  size: number;
}

const getDriveUrl = (file: { id: string; isFolder?: boolean }) => {
  if (file.isFolder) {
    return `https://drive.google.com/drive/folders/${file.id}`;
  }
  return `https://drive.google.com/file/d/${file.id}/view`;
};

export function TreeMap({ pollWhileScanning = false }: { pollWhileScanning?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [currentParentId, setCurrentParentId] = useState<string | undefined>(undefined);
  const [hoveredFile, setHoveredFile] = useState<TreemapFile | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string | undefined; name: string }>>([
    { id: undefined, name: 'Root' }
  ]);

  const { data, isLoading } = useQuery({
    queryKey: ['treemap', currentParentId],
    queryFn: () => filesApi.getTreemap(currentParentId),
    refetchInterval: pollWhileScanning ? 2500 : false,
  });

  const navigateToFolder = (file: TreemapFile) => {
    if (file.isFolder) {
      setCurrentParentId(file.id);
      setBreadcrumbs(prev => [...prev, { id: file.id, name: file.name }]);
    }
  };

  const navigateToBreadcrumb = (index: number) => {
    const crumb = breadcrumbs[index];
    setCurrentParentId(crumb.id);
    setBreadcrumbs(prev => prev.slice(0, index + 1));
  };

  useEffect(() => {
    if (!data?.files || !containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = 500;

    // Clear previous
    d3.select(container).selectAll('*').remove();

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    // Filter out zero-size items and prepare hierarchy
    const validFiles = data.files.filter(f => f.size > 0);
    
    if (validFiles.length === 0) {
      svg.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#71717a')
        .text('No files in this folder');
      return;
    }

    const root = d3.hierarchy({ children: validFiles } as any)
      .sum((d: any) => d.size || 0)
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    const treemap = d3.treemap<any>()
      .size([width, height])
      .paddingOuter(4)
      .paddingInner(2)
      .round(true);

    treemap(root);

    const colorMap: Record<string, string> = {
      delete: '#f72585',
      compress: '#fee440',
      keep: '#00f5d4',
    };

    const nodes = svg.selectAll('g')
      .data(root.leaves())
      .join('g')
      .attr('transform', (d: any) => `translate(${d.x0},${d.y0})`);

    // Rectangles
    nodes.append('rect')
      .attr('width', (d: any) => Math.max(0, d.x1 - d.x0))
      .attr('height', (d: any) => Math.max(0, d.y1 - d.y0))
      .attr('rx', 4)
      .attr('fill', (d: any) => {
        const suggestion = d.data.suggestion;
        if (d.data.isFolder) return '#252532';
        return colorMap[suggestion] || '#3a3a4a';
      })
      .attr('fill-opacity', (d: any) => d.data.isFolder ? 0.8 : 0.7)
      .attr('stroke', (d: any) => d.data.isFolder ? '#00f5d4' : 'none')
      .attr('stroke-width', (d: any) => d.data.isFolder ? 2 : 0)
      .style('cursor', 'pointer')
      .on('click', (event: any, d: any) => {
        // Shift+click or right-click opens in Google Drive
        if (event.shiftKey) {
          window.open(getDriveUrl(d.data), '_blank');
          return;
        }
        if (d.data.isFolder) {
          navigateToFolder(d.data);
        }
      })
      .on('contextmenu', (event: any, d: any) => {
        event.preventDefault();
        window.open(getDriveUrl(d.data), '_blank');
      })
      .on('mouseover', function(this: SVGRectElement, event: any, d: any) {
        d3.select(this).attr('fill-opacity', 0.9);
        setHoveredFile(d.data);
        setTooltipPos({ x: event.pageX, y: event.pageY });
      })
      .on('mousemove', (event: any) => {
        setTooltipPos({ x: event.pageX, y: event.pageY });
      })
      .on('mouseout', function(this: SVGRectElement, event: any, d: any) {
        d3.select(this).attr('fill-opacity', d.data.isFolder ? 0.8 : 0.7);
        setHoveredFile(null);
      });

    // Labels (only for larger boxes)
    nodes.filter((d: any) => (d.x1 - d.x0) > 60 && (d.y1 - d.y0) > 40)
      .append('text')
      .attr('x', 6)
      .attr('y', 18)
      .attr('fill', (d: any) => {
        const suggestion = d.data.suggestion;
        if (suggestion === 'compress') return '#18181b'; // Dark text on yellow
        return '#ffffff';
      })
      .attr('font-size', '12px')
      .attr('font-weight', '500')
      .style('pointer-events', 'none')
      .text((d: any) => {
        // Show drive prefix for root-level items to distinguish duplicates
        let name = d.data.name;
        const path = d.data.path || '';
        const pathParts = path.split('/');
        if (pathParts.length >= 2 && pathParts[0] === 'Shared Drive') {
          // This is from a shared drive root, no prefix needed
        } else if (pathParts.length === 2) {
          // Add drive indicator
          name = `${pathParts[0].substring(0, 8)}…/${name}`;
        }
        const maxWidth = d.x1 - d.x0 - 12;
        const charWidth = 7;
        const maxChars = Math.floor(maxWidth / charWidth);
        return name.length > maxChars ? name.slice(0, maxChars - 2) + '...' : name;
      });

    // Size labels
    nodes.filter((d: any) => (d.x1 - d.x0) > 60 && (d.y1 - d.y0) > 55)
      .append('text')
      .attr('x', 6)
      .attr('y', 34)
      .attr('fill', (d: any) => {
        const suggestion = d.data.suggestion;
        if (suggestion === 'compress') return '#18181b99';
        return '#ffffff99';
      })
      .attr('font-size', '11px')
      .style('pointer-events', 'none')
      .text((d: any) => formatBytes(d.data.size));

    // Folder icon for folders
    nodes.filter((d: any) => d.data.isFolder && (d.x1 - d.x0) > 30 && (d.y1 - d.y0) > 30)
      .append('text')
      .attr('x', (d: any) => (d.x1 - d.x0) - 20)
      .attr('y', (d: any) => (d.y1 - d.y0) - 8)
      .attr('fill', '#00f5d4')
      .attr('font-size', '14px')
      .style('pointer-events', 'none')
      .text('📁');

  }, [data]);

  return (
    <div className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Storage Map</h2>
        
        {/* Breadcrumbs */}
        <div className="flex items-center gap-2 text-sm">
          {breadcrumbs.map((crumb, index) => (
            <button
              key={crumb.id || 'root'}
              onClick={() => navigateToBreadcrumb(index)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors ${
                index === breadcrumbs.length - 1
                  ? 'text-white bg-void-700'
                  : 'text-zinc-500 hover:text-white hover:bg-void-800'
              }`}
            >
              {index === 0 && <Home className="w-3 h-3" />}
              {crumb.name}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 mb-4 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-neon-pink" />
          <span className="text-zinc-400">Delete</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-neon-yellow" />
          <span className="text-zinc-400">Compress</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-neon-cyan" />
          <span className="text-zinc-400">Keep</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-void-600 border border-neon-cyan" />
          <span className="text-zinc-400">Folder (click to enter)</span>
        </div>
      </div>

      {/* Treemap container */}
      <div 
        ref={containerRef} 
        className="w-full h-[500px] rounded-xl overflow-hidden bg-void-800/50"
      >
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin w-8 h-8 border-2 border-neon-cyan border-t-transparent rounded-full" />
          </div>
        )}
      </div>

      {/* Tooltip */}
      {hoveredFile && (
        <div
          ref={tooltipRef}
          className="fixed z-50 glass rounded-lg p-3 shadow-xl pointer-events-none max-w-sm"
          style={{
            left: tooltipPos.x + 10,
            top: tooltipPos.y + 10,
          }}
        >
          <p className="font-medium text-sm truncate">{hoveredFile.name}</p>
          <p className="text-xs text-zinc-400 truncate mt-1">{hoveredFile.path}</p>
          <p className="text-xs text-zinc-500 mt-2">
            {formatBytes(hoveredFile.size)}
            {hoveredFile.suggestion && (
              <span className={`ml-2 ${
                hoveredFile.suggestion === 'delete' ? 'text-neon-pink' :
                hoveredFile.suggestion === 'compress' ? 'text-neon-yellow' :
                'text-neon-cyan'
              }`}>
                • {hoveredFile.suggestion}
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-600 mt-2">
            {hoveredFile.isFolder ? 'Click to enter' : 'Shift+click'} or right-click → Open in Drive
          </p>
        </div>
      )}

      {/* Instructions */}
      <p className="text-xs text-zinc-600 mt-3 text-center">
        💡 Shift+click or right-click any item to open in Google Drive
      </p>
    </div>
  );
}
