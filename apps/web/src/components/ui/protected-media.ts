import type * as React from 'react';

export const protectedImageProps = {
  draggable: false,
  onContextMenu: (event) => event.preventDefault(),
  onDragStart: (event) => event.preventDefault(),
} satisfies Pick<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'draggable' | 'onContextMenu' | 'onDragStart'
>;

export const protectedVideoProps = {
  controlsList: 'nodownload noplaybackrate noremoteplayback',
  disablePictureInPicture: true,
  disableRemotePlayback: true,
  draggable: false,
  onContextMenu: (event) => event.preventDefault(),
  onDragStart: (event) => event.preventDefault(),
} satisfies Pick<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  | 'controlsList'
  | 'disablePictureInPicture'
  | 'disableRemotePlayback'
  | 'draggable'
  | 'onContextMenu'
  | 'onDragStart'
>;

export const protectedMediaContainerProps = {
  onContextMenu: (event) => event.preventDefault(),
  onDragStart: (event) => event.preventDefault(),
} satisfies Pick<
  React.HTMLAttributes<HTMLElement>,
  'onContextMenu' | 'onDragStart'
>;
