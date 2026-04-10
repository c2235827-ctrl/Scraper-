/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Download, Copy, Users, QrCode, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import QRCode from 'react-qr-code';

export default function App() {
  const [link, setLink] = useState('');
  const [status, setStatus] = useState<'idle' | 'scanning' | 'qr' | 'scraping' | 'done' | 'error'>('idle');
  const [members, setMembers] = useState<string[]>([]);
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const pollingInterval = useRef<NodeJS.Timeout | null>(null);

  const startScraping = async () => {
    if (!link.trim()) {
      setErrorMsg('Please enter a valid WhatsApp group link');
      setStatus('error');
      return;
    }
    
    try {
      setStatus('scanning');
      setErrorMsg('');
      setMembers([]);
      setQrCodeData(null);
      
      const res = await fetch('/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link })
      });
      
      if (!res.ok) throw new Error('Failed to start scraping');
      
      // Start polling
      if (pollingInterval.current) clearInterval(pollingInterval.current);
      pollingInterval.current = setInterval(pollStatus, 2000);
      
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const pollStatus = async () => {
    try {
      const res = await fetch('/status');
      if (!res.ok) throw new Error('Failed to fetch status');
      
      const data = await res.json();
      
      if (data.qrCode) {
        setQrCodeData(data.qrCode);
      }

      if (data.status === 'qr') setStatus('qr');
      else if (data.status === 'scraping') setStatus('scraping');
      else if (data.status === 'done') {
        setStatus('done');
        setMembers(data.members || []);
        if (pollingInterval.current) clearInterval(pollingInterval.current);
      }
    } catch (err) {
      console.error(err);
      if (pollingInterval.current) clearInterval(pollingInterval.current);
      setStatus('error');
      setErrorMsg('Lost connection to server');
    }
  };

  useEffect(() => {
    return () => {
      if (pollingInterval.current) clearInterval(pollingInterval.current);
    };
  }, []);

  const copyAll = () => {
    navigator.clipboard.writeText(members.join('\n'));
    // Could add a toast here
  };

  const downloadTxt = () => {
    const element = document.createElement('a');
    const file = new Blob([members.join('\n')], {type: 'text/plain'});
    element.href = URL.createObjectURL(file);
    element.download = 'whatsapp_group_members.txt';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const resetScraper = async () => {
    try {
      await fetch('/reset', { method: 'POST' });
      setStatus('idle');
      setLink('');
      setMembers([]);
      setQrCodeData(null);
      setErrorMsg('');
    } catch (err) {
      console.error('Failed to reset:', err);
    }
  };

  return (
    <div className="min-h-screen bg-[#111b21] text-[#e9edef] font-sans selection:bg-[#00a884] selection:text-white flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-2xl space-y-8">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-[#202c33] rounded-2xl mb-4 shadow-lg">
            <Users className="w-8 h-8 text-[#00a884]" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">WA Group Scraper</h1>
          <p className="text-[#8696a0]">Extract phone numbers and names from any WhatsApp group invite link.</p>
        </div>

        {/* Main Card */}
        <div className="bg-[#202c33] rounded-2xl shadow-xl overflow-hidden border border-[#2a3942]">
          <div className="p-6 sm:p-8 space-y-6">
            
            {/* Input Section */}
            <div className="space-y-3">
              <label htmlFor="link" className="block text-sm font-medium text-[#8696a0]">
                WhatsApp Group Invite Link
              </label>
              <div className="flex gap-3 flex-col sm:flex-row">
                <input
                  type="text"
                  id="link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://chat.whatsapp.com/..."
                  className="flex-1 bg-[#2a3942] border border-[#2a3942] focus:border-[#00a884] rounded-xl px-4 py-3 text-[#e9edef] placeholder:text-[#8696a0] outline-none transition-colors"
                  disabled={status === 'scanning' || status === 'qr' || status === 'scraping'}
                />
                <button
                  onClick={startScraping}
                  disabled={status === 'scanning' || status === 'qr' || status === 'scraping'}
                  className="bg-[#00a884] hover:bg-[#008f6f] text-[#111b21] font-semibold px-6 py-3 rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {status === 'scanning' || status === 'qr' || status === 'scraping' ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Users className="w-5 h-5" />
                  )}
                  Extract Numbers
                </button>
              </div>
            </div>

            {/* Status Area */}
            {status !== 'idle' && (
              <div className={`rounded-xl p-4 flex flex-col gap-4 ${
                status === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                status === 'done' ? 'bg-[#00a884]/10 text-[#00a884] border border-[#00a884]/20' :
                'bg-[#2a3942] text-[#e9edef]'
              }`}>
                <div className="flex items-center gap-3">
                  {status === 'error' && <AlertCircle className="w-5 h-5 shrink-0" />}
                  {status === 'done' && <CheckCircle2 className="w-5 h-5 shrink-0" />}
                  {status === 'qr' && <QrCode className="w-5 h-5 shrink-0 animate-pulse text-[#00a884]" />}
                  {(status === 'scanning' || status === 'scraping') && <Loader2 className="w-5 h-5 shrink-0 animate-spin text-[#00a884]" />}
                  
                  <div className="flex-1 font-medium">
                    {status === 'scanning' && 'Initializing scraper...'}
                    {status === 'qr' && 'Scan the QR code below with your WhatsApp app to log in.'}
                    {status === 'scraping' && 'Scanning group members...'}
                    {status === 'done' && 'Extraction complete!'}
                    {status === 'error' && errorMsg}
                  </div>
                </div>

                {status === 'qr' && qrCodeData && (
                  <div className="flex justify-center p-6 bg-white rounded-xl mx-auto mt-2">
                    <QRCode value={qrCodeData} size={256} />
                  </div>
                )}
                
                {status === 'done' && members.length === 0 && (
                  <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-500 text-sm font-medium flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <div>
                      No members could be extracted. This could mean:
                      <ul className="list-disc ml-5 mt-2 space-y-1 text-yellow-500/80">
                        <li>The group is completely empty.</li>
                        <li>WhatsApp blocked the automated browser.</li>
                        <li>The WhatsApp Web layout changed.</li>
                      </ul>
                    </div>
                  </div>
                )}
                
                {status === 'done' && (
                  <div className="flex justify-end mt-2">
                    <button
                      onClick={resetScraper}
                      className="text-sm font-medium text-[#00a884] hover:text-[#008f6f] transition-colors"
                    >
                      Scrape Another Group
                    </button>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* Results Panel */}
        {status === 'done' && members.length > 0 && (
          <div className="bg-[#202c33] rounded-2xl shadow-xl overflow-hidden border border-[#2a3942] animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 border-b border-[#2a3942] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="bg-[#00a884] text-[#111b21] text-xs font-bold px-2 py-1 rounded-md">
                  {members.length}
                </span>
                Members Extracted
              </h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={copyAll}
                  className="flex items-center gap-2 px-4 py-2 bg-[#2a3942] hover:bg-[#374b57] text-[#e9edef] rounded-lg transition-colors text-sm font-medium"
                >
                  <Copy className="w-4 h-4" />
                  Copy All
                </button>
                <button
                  onClick={downloadTxt}
                  className="flex items-center gap-2 px-4 py-2 bg-[#2a3942] hover:bg-[#374b57] text-[#e9edef] rounded-lg transition-colors text-sm font-medium"
                >
                  <Download className="w-4 h-4" />
                  Download .txt
                </button>
              </div>
            </div>
            
            <div className="p-0">
              <div className="max-h-[400px] overflow-y-auto custom-scrollbar">
                <ul className="divide-y divide-[#2a3942]">
                  {members.map((member, idx) => (
                    <li key={idx} className="px-6 py-3 hover:bg-[#2a3942]/50 transition-colors flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#2a3942] flex items-center justify-center text-[#8696a0] text-xs font-medium shrink-0">
                        {idx + 1}
                      </div>
                      <span className="text-[#e9edef] font-mono text-sm">{member}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
