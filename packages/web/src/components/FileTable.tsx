'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Folder, Film, File,
  Trash2, Minimize2, Check, MoreHorizontal, ArrowUpDown, ExternalLink, CloudOff,
} from 'lucide-react';
import { filesApi, actionsApi, formatBytes, formatDuration, formatBitrate, DriveFile, statsApi } from '@/lib/api';

const PAGE_SIZE = 200;

export function FileTable({ pollWhileScanning = false }: { pollWhileScanning?: boolean }) {
  const [search, setSearch] = useState('');
  const [suggestionFilter, setSuggestionFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState('size');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [hideCompressed, setHideCompressed] = useState(true);
  const [hideQueued, setHideQueued] = useState(true);
  /** Drive index: all | only still on Drive | only flagged missing after last scan */
  const [drivePresence, setDrivePresence] = useState<'any' | 'present' | 'missing'>('any');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: statsApi.get,
  });

  const { data, isLoading } = useQuery({
    queryKey: [
      'files',
      {
        search,
        suggestionFilter,
        sortBy,
        sortOrder,
        page,
        hideCompressed,
        hideQueued,
        drivePresence,
      },
    ],
    queryFn: () =>
      filesApi.list({
        search: search || undefined,
        suggestion: suggestionFilter || undefined,
        sortBy,
        sortOrder,
        page,
        limit: PAGE_SIZE,
        videosOnly: true,
        excludeCompressed: hideCompressed || undefined,
        excludeQueued: hideQueued || undefined,
        missingOnly: drivePresence === 'missing' || undefined,
        hideMissing: drivePresence === 'present' || undefined,
      }),
    refetchInterval: pollWhileScanning ? 2500 : false,
  });

  const queueAction = useMutation({
    mutationFn: ({ fileIds, action }: { fileIds: string[]; action: 'delete' | 'compress' }) =>
      actionsApi.create(fileIds, action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['actions'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setSelectedFiles(new Set());
    },
  });

  const updateSuggestion = useMutation({
    mutationFn: ({ fileIds, suggestion }: { fileIds: string[]; suggestion: 'delete' | 'compress' | 'keep' }) =>
      filesApi.updateSuggestions(fileIds, suggestion),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const toggleSelect = (fileId: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(fileId)) {
      newSelected.delete(fileId);
    } else {
      newSelected.add(fileId);
    }
    setSelectedFiles(newSelected);
  };

  const selectAll = () => {
    if (!data?.files) return;
    if (selectedFiles.size === data.files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(data.files.map(f => f.id)));
    }
  };

  const getSuggestionBadge = (suggestion: string | null) => {
    switch (suggestion) {
      case 'delete':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-neon-pink/20 text-neon-pink">Delete</span>;
      case 'compress':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-neon-yellow/20 text-neon-yellow">Compress</span>;
      case 'keep':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-neon-cyan/20 text-neon-cyan">Keep</span>;
      default:
        return <span className="px-2 py-0.5 text-xs rounded-full bg-zinc-700 text-zinc-400">Unanalyzed</span>;
    }
  };

  const getFileIcon = (file: DriveFile) => {
    if (file.isFolder) return <Folder className="w-4 h-4 text-neon-cyan" />;
    if (file.mimeType?.startsWith('video/')) return <Film className="w-4 h-4 text-neon-purple" />;
    return <File className="w-4 h-4 text-zinc-500" />;
  };

  const getDriveUrl = (file: DriveFile) => {
    if (file.isFolder) {
      return `https://drive.google.com/drive/folders/${file.id}`;
    }
    return `https://drive.google.com/file/d/${file.id}/view`;
  };

  return (
    <div className="glass rounded-2xl overflow-hidden flex flex-col flex-1 min-h-0 min-w-0">
      {/* Toolbar */}
      <div className="p-4 border-b border-zinc-800/50 flex flex-wrap items-center gap-4 shrink-0">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-void-800 rounded-xl border border-zinc-800 focus:border-neon-cyan/50 focus:outline-none text-sm"
          />
        </div>

        {/* Suggestion filter */}
        <select
          value={suggestionFilter}
          onChange={(e) => {
            setSuggestionFilter(e.target.value);
            setPage(1);
          }}
          className="px-4 py-2 bg-void-800 rounded-xl border border-zinc-800 text-sm focus:outline-none focus:border-neon-cyan/50"
        >
          <option value="">All suggestions</option>
          <option value="delete">Delete</option>
          <option value="compress">Compress</option>
          <option value="keep">Keep</option>
        </select>

        <select
          value={drivePresence}
          onChange={(e) => {
            setDrivePresence(e.target.value as 'any' | 'present' | 'missing');
            setPage(1);
          }}
          title="Filter by whether the file was seen in the last completed Drive scan"
          className="px-4 py-2 bg-void-800 rounded-xl border border-zinc-800 text-sm focus:outline-none focus:border-neon-cyan/50 max-w-[13rem]"
        >
          <option value="any">All videos (index)</option>
          <option value="present">On Drive (last scan)</option>
          <option value="missing">
            Gone from Drive ({(stats?.storage.goneFromDriveVideos ?? 0).toLocaleString()})
          </option>
        </select>

        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={hideCompressed}
            onChange={(e) => {
              setHideCompressed(e.target.checked);
              setPage(1);
            }}
            className="rounded bg-void-700 border-zinc-700"
          />
          Hide compressed
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={hideQueued}
            onChange={(e) => {
              setHideQueued(e.target.checked);
              setPage(1);
            }}
            className="rounded bg-void-700 border-zinc-700"
          />
          Hide in queue
        </label>

        {/* Sort */}
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value);
              setPage(1);
            }}
            className="px-4 py-2 bg-void-800 rounded-xl border border-zinc-800 text-sm focus:outline-none focus:border-neon-cyan/50"
          >
            <option value="size">Size</option>
            <option value="bitrate">Bitrate</option>
            <option value="name">Name</option>
            <option value="modifiedAt">Modified</option>
          </select>
          <button
            onClick={() => {
              setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
              setPage(1);
            }}
            className="p-2 bg-void-800 rounded-xl border border-zinc-800 hover:border-zinc-700"
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>
        </div>

        {/* Bulk actions */}
        {selectedFiles.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-sm text-zinc-400">{selectedFiles.size} selected</span>
            <button
              onClick={() => queueAction.mutate({ fileIds: Array.from(selectedFiles), action: 'delete' })}
              className="px-3 py-1.5 bg-neon-pink/20 text-neon-pink rounded-lg text-sm hover:bg-neon-pink/30"
            >
              <Trash2 className="w-4 h-4 inline mr-1" />
              Queue Delete
            </button>
            <button
              onClick={() => queueAction.mutate({ fileIds: Array.from(selectedFiles), action: 'compress' })}
              className="px-3 py-1.5 bg-neon-yellow/20 text-neon-yellow rounded-lg text-sm hover:bg-neon-yellow/30"
            >
              <Minimize2 className="w-4 h-4 inline mr-1" />
              Queue Compress
            </button>
          </div>
        )}
      </div>

      {/* Table — scrolls inside viewport; page shell does not grow */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full min-w-[820px]">
          <thead className="sticky top-0 z-10 bg-void-800/95 backdrop-blur-sm shadow-[0_1px_0_0_rgba(39,39,42,0.6)]">
            <tr className="text-left text-sm text-zinc-500 border-b border-zinc-800/50">
              <th className="p-4 w-8">
                <input
                  type="checkbox"
                  checked={data?.files && selectedFiles.size === data.files.length}
                  onChange={selectAll}
                  className="rounded bg-void-700 border-zinc-700"
                />
              </th>
              <th className="p-4">Name / Drive</th>
              <th className="p-4 w-28">Size</th>
              <th className="p-4 w-24">Duration</th>
              <th className="p-4 w-28">Resolution</th>
              <th className="p-4 w-28">Bitrate</th>
              <th className="p-4 w-28">Suggestion</th>
              <th className="p-4 w-[11rem] text-right">Queue</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-zinc-500">
                  <div className="animate-spin w-6 h-6 border-2 border-neon-cyan border-t-transparent rounded-full mx-auto" />
                </td>
              </tr>
            ) : data?.files.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-zinc-500">
                  No files found
                </td>
              </tr>
            ) : (
              data?.files.map((file) => (
                <tr 
                  key={file.id} 
                  className={`border-b border-zinc-800/30 hover:bg-void-800/50 transition-colors ${
                    selectedFiles.has(file.id) ? 'bg-void-700/50' : ''
                  } ${file.missingFromDrive ? 'bg-amber-500/[0.04]' : ''}`}
                >
                  <td className="p-4">
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(file.id)}
                      onChange={() => toggleSelect(file.id)}
                      className="rounded bg-void-700 border-zinc-700"
                    />
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      {getFileIcon(file)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium truncate max-w-md">{file.name}</p>
                          {file.missingFromDrive ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-200/95 border border-amber-500/30 shrink-0"
                              title="Not seen in the last completed scan — file may have been removed from Drive or moved outside the scanned folder"
                            >
                              <CloudOff className="w-3 h-3" />
                              Gone
                            </span>
                          ) : null}
                          <a
                            href={getDriveUrl(file)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-500 hover:text-neon-cyan transition-colors flex-shrink-0"
                            title={file.missingFromDrive ? 'Link may 404 if file was removed' : 'Open in Google Drive'}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                        <p className="text-xs text-zinc-500 truncate max-w-md">{file.path}</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-4 tabular-nums">{formatBytes(file.size)}</td>
                  <td className="p-4 tabular-nums text-zinc-400">{formatDuration(file.duration)}</td>
                  <td className="p-4 text-zinc-400">
                    {file.width && file.height ? `${file.width}×${file.height}` : '-'}
                  </td>
                  <td className="p-4 tabular-nums text-zinc-400">
                    {formatBitrate(file.size, file.duration)}
                  </td>
                  <td className="p-4">
                    {getSuggestionBadge(file.suggestion)}
                    {file.suggestionReason && (
                      <p className="text-xs text-zinc-500 mt-1 truncate max-w-[150px]" title={file.suggestionReason}>
                        {file.suggestionReason}
                      </p>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        title="Queue for deletion"
                        onClick={() => queueAction.mutate({ fileIds: [file.id], action: 'delete' })}
                        disabled={queueAction.isPending}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-neon-pink/15 text-neon-pink border border-neon-pink/25 hover:bg-neon-pink/25 disabled:opacity-40 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="hidden sm:inline">Delete</span>
                      </button>
                      <button
                        type="button"
                        title="Queue for compression"
                        onClick={() => queueAction.mutate({ fileIds: [file.id], action: 'compress' })}
                        disabled={queueAction.isPending}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-neon-yellow/15 text-neon-yellow border border-neon-yellow/25 hover:bg-neon-yellow/25 disabled:opacity-40 transition-colors"
                      >
                        <Minimize2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="hidden sm:inline">Compress</span>
                      </button>
                      <div className="relative group">
                        <button
                          type="button"
                          title="More"
                          className="p-1.5 rounded-lg hover:bg-void-700 text-zinc-400"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                        <div className="absolute right-0 top-full mt-1 py-2 w-48 glass rounded-xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-20">
                          <button
                            type="button"
                            onClick={() => updateSuggestion.mutate({ fileIds: [file.id], suggestion: 'delete' })}
                            className="w-full px-4 py-2 text-left text-sm hover:bg-void-700 flex items-center gap-2"
                          >
                            <Trash2 className="w-4 h-4 text-neon-pink" /> Mark as Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => updateSuggestion.mutate({ fileIds: [file.id], suggestion: 'compress' })}
                            className="w-full px-4 py-2 text-left text-sm hover:bg-void-700 flex items-center gap-2"
                          >
                            <Minimize2 className="w-4 h-4 text-neon-yellow" /> Mark as Compress
                          </button>
                          <button
                            type="button"
                            onClick={() => updateSuggestion.mutate({ fileIds: [file.id], suggestion: 'keep' })}
                            className="w-full px-4 py-2 text-left text-sm hover:bg-void-700 flex items-center gap-2"
                          >
                            <Check className="w-4 h-4 text-neon-cyan" /> Mark as Keep
                          </button>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && (
        <div className="p-4 border-t border-zinc-800/50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <p className="text-sm text-zinc-500">
            Showing {(page - 1) * PAGE_SIZE + 1} –{' '}
            {Math.min(page * PAGE_SIZE, data.pagination.total)} of{' '}
            {data.pagination.total.toLocaleString()}
            <span className="text-zinc-600"> ({PAGE_SIZE} per page)</span>
          </p>
          {data.pagination.totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 bg-void-800 rounded-lg text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-zinc-400">
                Page {page} of {data.pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(data.pagination.totalPages, p + 1))}
                disabled={page === data.pagination.totalPages}
                className="px-3 py-1.5 bg-void-800 rounded-lg text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
