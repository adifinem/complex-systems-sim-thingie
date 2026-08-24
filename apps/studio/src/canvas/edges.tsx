import { BaseEdge, type EdgeProps, getBezierPath, getSmoothStepPath } from '@xyflow/react'
import { memo, useEffect, useRef } from 'react'
import { bridge } from '../engine/bridge'

/**
 * Edge widgets. Like nodes, they render static structure; the AnimationBridge
 * drives dash offset / width / color / dormancy imperatively per frame.
 */

export const PipeEdgeView = memo(
  ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) => {
    const core = useRef<SVGPathElement>(null)
    const flowId = (data as { flowId?: string } | undefined)?.flowId
    const [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 14,
    })
    useEffect(() => {
      if (!core.current || !flowId) return
      bridge.registerEdge(id, { kind: 'pipe', el: core.current, flowPath: flowId })
      return () => bridge.unregisterEdge(id)
    }, [id, flowId])
    return (
      <>
        <BaseEdge id={id} path={path} className="mm-pipe-conduit" style={{ strokeWidth: 9 }} />
        <path ref={core} d={path} className="mm-pipe-core" style={{ strokeWidth: 3 }} />
      </>
    )
  },
)

export const WireEdgeView = memo(
  ({
    id,
    source,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  }: EdgeProps) => {
    const el = useRef<SVGPathElement>(null)
    const [path] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    })
    useEffect(() => {
      if (!el.current) return
      bridge.registerEdge(id, { kind: 'wire', el: el.current, linkId: id, sourcePath: source })
      return () => bridge.unregisterEdge(id)
    }, [id, source])
    return <path ref={el} d={path} className="mm-wire" />
  },
)

export const edgeTypes = {
  pipe: PipeEdgeView,
  wire: WireEdgeView,
}
