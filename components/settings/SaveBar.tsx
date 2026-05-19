'use client'

interface SaveBarProps {
  isDirty?: boolean
  isSaving?: boolean
  onSave?: () => void
  onDiscard?: () => void
}

export default function SaveBar({ isDirty, isSaving, onSave, onDiscard }: SaveBarProps) {
  return (
    <div className="save-bar">
      <div className="changes">
        {isDirty ? (
          <>
            <span className="pip" style={{ background: '#F59E0B' }}></span>
            <span>Unsaved changes</span>
          </>
        ) : (
          <span>All changes saved · <span style={{ color: 'var(--tc-ink-soft)' }}>just now</span></span>
        )}
      </div>
      <button
        className="btn-ghost"
        onClick={onDiscard}
        disabled={!isDirty || isSaving}
      >
        Discard
      </button>
      <button
        className="btn-solid"
        onClick={onSave}
        disabled={!isDirty || isSaving}
      >
        {isSaving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}
