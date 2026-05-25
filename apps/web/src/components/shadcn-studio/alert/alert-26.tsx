import { CircleAlertIcon } from 'lucide-react'

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'

const AlertSolidDemo = () => {
  return (
    <Alert className='app-noise w-[360px] max-w-[calc(100vw-2rem)] border-primary/20 bg-card shadow-lg'>
      <CircleAlertIcon className='text-primary' />
      <AlertTitle>更改未保存</AlertTitle>
      <AlertDescription className='text-muted-foreground'>
        您已取消编辑，未点击“保存”的更改不会生效。
      </AlertDescription>
    </Alert>
  )
}

export default AlertSolidDemo
