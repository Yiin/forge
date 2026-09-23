import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const METHODS = [
  { value: 'oauth', label: 'Browser sign-in (OAuth)' },
  { value: 'api-key', label: 'API key' },
]

/** First step of an opencode or pi sign-in: which provider, which method. */
export function LoginOptionsDialog({
  title,
  provider: initialProvider,
  onCancel,
  onSubmit,
}: {
  title: string
  provider: string
  onCancel: () => void
  onSubmit: (provider: string, method: string) => void
}) {
  const providerId = useId()
  const methodId = useId()
  const [provider, setProvider] = useState(initialProvider)
  const [method, setMethod] = useState('oauth')
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(provider.trim(), method)
          }}
        >
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-[15px] font-semibold tracking-tight">
              {title}
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              Choose the model provider and how to sign in to it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor={providerId}>Provider</Label>
              <Input
                id={providerId}
                value={provider}
                autoFocus
                onChange={(event) => setProvider(event.target.value)}
                placeholder="anthropic, openai, …"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={methodId}>Sign-in method</Label>
              <Select
                value={method}
                items={METHODS}
                onValueChange={(value) => setMethod(value ?? 'oauth')}
              >
                <SelectTrigger id={methodId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
