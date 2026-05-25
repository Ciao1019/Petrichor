import { CheckCheckIcon } from 'lucide-react'

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'

const AlertSolidSuccessDemo = () => {
  return (
    <Alert className='app-noise w-[360px] max-w-[calc(100vw-2rem)] border-emerald-500/25 bg-card shadow-lg dark:border-emerald-400/25'>
      <CheckCheckIcon className='text-emerald-600 dark:text-emerald-400' />
      <AlertTitle>资料已更新</AlertTitle>
      <AlertDescription className='text-muted-foreground'>您的更改已保存成功。</AlertDescription>
    </Alert>
  )
}

export default AlertSolidSuccessDemo
