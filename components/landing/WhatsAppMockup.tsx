'use client'

import React from 'react'

export default function WhatsAppMockup() {
  return (
    <div className="w-full max-w-md mx-auto bg-[#efeae2] rounded-2xl shadow-xl overflow-hidden border border-[#e0dcd5] font-sans">
      {/* WhatsApp Header */}
      <div className="bg-[#008069] text-white px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Back Arrow Icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-90">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
          
          {/* Avatar (guest) */}
          <div className="w-10 h-10 rounded-full bg-[#128C7E] flex items-center justify-center font-semibold text-white shadow-sm border border-white/10">
            A
          </div>

          <div>
            <div className="font-semibold text-[15px] leading-tight">Anna · cruise guest</div>
            <div className="text-[11px] text-white/80">Caye is replying…</div>
          </div>
        </div>
        
        {/* Header Icons */}
        <div className="flex items-center gap-4 opacity-90">
          {/* Video Call Icon */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>
          {/* Phone Call Icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
          </svg>
          {/* More Menu Icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="1"></circle>
            <circle cx="12" cy="5" r="1"></circle>
            <circle cx="12" cy="19" r="1"></circle>
          </svg>
        </div>
      </div>

      {/* Chat Area */}
      <div className="p-4 space-y-4 min-height-[320px] max-height-[400px] overflow-y-auto bg-[url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')] bg-repeat bg-opacity-40">
        
        {/* Inbound Message */}
        <div className="flex justify-start">
          <div className="bg-white text-[#111b21] px-3.5 py-2 rounded-2xl rounded-tl-none shadow-sm max-w-[85%] text-[14.5px] leading-relaxed relative">
            <p>Hi! Saw you on IG — y&apos;all have anything Saturday for a family of 5? First time in Bimini 🙌</p>
            <div className="text-right text-[10px] text-[#667781] mt-1">9:41 AM</div>
          </div>
        </div>

        {/* Caye Reply 1 */}
        <div className="flex justify-end">
          <div className="bg-[#d9fdd3] text-[#111b21] px-3.5 py-2 rounded-2xl rounded-tr-none shadow-sm max-w-[85%] text-[14.5px] leading-relaxed relative">
            <p>Hi Anna! Welcome ahead of time 🌺 Saturday 10am we have the North Bimini Heritage Tour open — 2 hours, private for your family of 5, $750.</p>
            <div className="flex items-center justify-end gap-1 text-[10px] text-[#667781] mt-1">
              <span>9:41 AM</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#53bdeb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
                <polyline points="20 12 9 23 4 18"></polyline>
              </svg>
            </div>
          </div>
        </div>

        {/* Caye Reply 2 */}
        <div className="flex justify-end">
          <div className="bg-[#d9fdd3] text-[#111b21] px-3.5 py-2 rounded-2xl rounded-tr-none shadow-sm max-w-[85%] text-[14.5px] leading-relaxed relative">
            <p>Want me to hold the slot? Just send the deposit through here and you&apos;re booked: <span className="text-[#0a66c2] underline">wetravel.com/bimini/north-heritage</span></p>
            <div className="flex items-center justify-end gap-1 text-[10px] text-[#667781] mt-1">
              <span>9:41 AM</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#53bdeb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
                <polyline points="20 12 9 23 4 18"></polyline>
              </svg>
            </div>
          </div>
        </div>

        {/* Caye System Toast — proof of work */}
        <div className="flex justify-center mt-2">
          <div className="bg-white/85 backdrop-blur-sm border border-[#e1dcd0] text-[#1e6157] font-mono text-[10.5px] font-semibold py-1 px-3 rounded-full flex items-center gap-1.5 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0FB5A1] animate-pulse"></span>
            Caye replied for you · slot held until paid
          </div>
        </div>

      </div>

      {/* WhatsApp Input Footer */}
      <div className="bg-[#f0f2f5] px-3 py-2.5 flex items-center gap-3">
        <div className="flex items-center gap-2 opacity-60">
          {/* Smiley Icon */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
            <line x1="9" y1="9" x2="9.01" y2="9"></line>
            <line x1="15" y1="9" x2="15.01" y2="9"></line>
          </svg>
          {/* Plus Icon */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </div>
        
        {/* Text Input Mock */}
        <div className="flex-1 bg-white rounded-lg px-3 py-1.5 text-sm text-gray-400 border border-[#e6e6e6]">
          Reply yes to confirm...
        </div>
        
        {/* Mic Icon */}
        <div className="opacity-60">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg>
        </div>
      </div>
    </div>
  )
}
