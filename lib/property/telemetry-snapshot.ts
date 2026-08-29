import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Founder presentation helper for Stage-2 property telemetry.
 * This is read-only and deliberately returns raw/current telemetry plus device
 * calibration metadata. UI consumers must not infer water volume unless a
 * calibrated derived measurement actually exists.
 */
export async function getFounderPropertyTelemetrySnapshot(propertyId: string) {
  const supabase = createServiceClient()
  const { data: property, error: propertyError } = await supabase
    .from('physical_properties')
    .select('id,workspace_id')
    .eq('id', propertyId)
    .maybeSingle()

  if (propertyError) throw new Error('Could not resolve property telemetry scope')
  if (!property) return { sensor_devices: [], current_telemetry: [] }

  const workspaceId = property.workspace_id as string
  const [devicesResult, telemetryResult] = await Promise.all([
    supabase
      .from('property_sensor_devices')
      .select('id,system_id,asset_id,device_key,provider,provider_application_id,provider_device_id,sensor_kind,status,calibration,metadata,installed_at,last_seen_at')
      .eq('workspace_id', workspaceId)
      .eq('property_id', propertyId)
      .order('created_at'),
    supabase
      .from('property_current_telemetry')
      .select('id,device_id,event_id,metric_key,numeric_value,unit,observed_at,quality,calibration_version,metadata,received_at,device_key,sensor_kind,device_status,last_seen_at')
      .eq('workspace_id', workspaceId)
      .eq('property_id', propertyId)
      .order('observed_at', { ascending: false }),
  ])

  if (devicesResult.error || telemetryResult.error) {
    throw new Error('Property telemetry snapshot is incomplete')
  }

  return {
    sensor_devices: devicesResult.data ?? [],
    current_telemetry: telemetryResult.data ?? [],
  }
}
