/**
 * d3-force-3d 官方未提供类型声明，这里只声明本项目实际用到的 API 面。
 * 与 newechoes 的做法一致：把力导模拟当作 1D/2D/3D 通用求解器使用，我们固定用 2D。
 */
declare module "d3-force-3d" {
    /** 力：每帧被模拟调用一次，initialize 用于拿到节点数组 */
    export interface Force<TNode> {
        (alpha: number): void
        initialize?(nodes: TNode[]): void
    }

    export interface LinkForce<TNode, TLink> extends Force<TNode> {
        id(accessor: (node: TNode) => string): this
        distance(accessor: (link: TLink) => number): this
        strength(accessor: (link: TLink) => number): this
        iterations(count: number): this
    }

    export interface ManyBodyForce<TNode> extends Force<TNode> {
        strength(accessor: (node: TNode) => number): this
        distanceMin(value: number): this
        distanceMax(value: number): this
    }

    export interface CollideForce<TNode> extends Force<TNode> {
        strength(value: number): this
        iterations(count: number): this
    }

    export interface Simulation<TNode> {
        alpha(value: number): this
        alphaMin(value: number): this
        alphaDecay(value: number): this
        alphaTarget(value: number): this
        velocityDecay(value: number): this
        force(name: string, force: Force<TNode> | null): this
        restart(): this
        stop(): this
        tick(iterations?: number): this
    }

    export function forceSimulation<TNode>(nodes: TNode[], numDimensions?: number): Simulation<TNode>
    export function forceLink<TNode, TLink>(links: TLink[]): LinkForce<TNode, TLink>
    export function forceManyBody<TNode>(): ManyBodyForce<TNode>
    export function forceCollide<TNode>(radius: (node: TNode) => number): CollideForce<TNode>
    export function forceCenter<TNode>(x: number, y: number, z?: number): Force<TNode>
}
