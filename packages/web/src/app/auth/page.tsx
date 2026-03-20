'use client';

import { useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { CheckCircle, XCircle } from 'lucide-react';

export default function AuthCallback() {
  const searchParams = useSearchParams();
  const router = useRouter();
  
  const success = searchParams.get('success');
  const error = searchParams.get('error');

  useEffect(() => {
    if (success) {
      // Redirect to dashboard after short delay
      const timeout = setTimeout(() => {
        router.push('/');
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [success, router]);

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="glass rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 mx-auto mb-6 rounded-xl bg-green-500/20 flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Authentication Successful</h1>
          <p className="text-zinc-400 mb-4">
            You've successfully connected your Google Drive.
          </p>
          <p className="text-sm text-zinc-500">Redirecting to dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="glass rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 mx-auto mb-6 rounded-xl bg-red-500/20 flex items-center justify-center">
            <XCircle className="w-8 h-8 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Authentication Failed</h1>
          <p className="text-zinc-400 mb-6">{decodeURIComponent(error)}</p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 rounded-xl bg-void-700 hover:bg-void-600 transition-colors font-medium"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="glass rounded-2xl p-8 max-w-md w-full text-center">
        <XCircle className="w-8 h-8 text-amber-400 mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-2">Invalid Authentication Response</h1>
        <p className="text-zinc-400 mb-6">
          Google sign-in did not return a success or error result.
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 rounded-xl bg-void-700 hover:bg-void-600 transition-colors font-medium"
        >
          Back to Dashboard
        </button>
      </div>
    </div>
  );
}
