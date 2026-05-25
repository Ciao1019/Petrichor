'use client'

import * as React from 'react'

import { toast } from 'sonner'

import { CheckCircle2Icon } from 'lucide-react'

export function toastWithIcon(message: string, options?: { icon?: React.ReactNode }) {
  toast(
    <div className='flex items-center gap-2'>
      {options?.icon ?? <CheckCircle2Icon className='size-5 shrink-0' />}
      <span className='text-sm leading-snug'>{message}</span>
    </div>
  )
}

export default toastWithIcon
