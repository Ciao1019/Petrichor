import { CircleAlertIcon } from 'lucide-react'

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'

const AlertSolidWarningDemo = () => {
  return (
    <Alert className='app-noise w-[360px] max-w-[calc(100vw-2rem)] border-amber-500/25 bg-card shadow-lg dark:border-amber-400/25'>
      <CircleAlertIcon className='text-amber-600 dark:text-amber-400' />
      <AlertTitle>一些细节缺失</AlertTitle>
      <AlertDescription className='text-muted-foreground'>填写您的个人资料以获得最佳体验。</AlertDescription>
    </Alert>
  )
}

export default AlertSolidWarningDemo
