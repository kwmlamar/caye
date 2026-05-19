import CayeMark from '@/components/ui/CayeMark'

export default function CayeFab({ onClick }: { onClick: () => void }) {
  return (
    <button className="caye-fab" onClick={onClick} title="Ask Caye">
      <CayeMark size={30} />
    </button>
  )
}
