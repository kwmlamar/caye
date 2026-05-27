'use client'

import React from 'react'

interface SuggestionChipProps {
  prompt: string
  onClick: () => void
}

export default function SuggestionChip({ prompt, onClick }: SuggestionChipProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between gap-3 bg-transparent hover:bg-[rgba(14,26,26,0.03)] text-[13.5px] text-near-black/70 hover:text-near-black border border-[rgba(14,26,26,0.08)] hover:border-[rgba(14,26,26,0.14)] rounded-xl px-4 py-3 transition-all font-sans w-full text-left cursor-pointer"
    >
      <span className="truncate">{prompt}</span>
      <span className="text-near-black/30 flex-shrink-0 text-lg leading-none font-normal">›</span>
    </button>
  )
}
