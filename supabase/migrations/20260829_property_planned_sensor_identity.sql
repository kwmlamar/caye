-- Planned sensor slots must be representable before hardware is purchased/provisioned.
-- Provider identity remains mandatory once a device advances beyond planning.

alter table public.property_sensor_devices
  alter column provider_device_id drop not null;

drop index if exists public.property_sensor_devices_provider_identity_idx;

create unique index property_sensor_devices_provider_identity_idx
  on public.property_sensor_devices(provider, coalesce(provider_application_id, ''), provider_device_id)
  where provider_device_id is not null;

alter table public.property_sensor_devices
  drop constraint if exists property_sensor_devices_identity_required_after_planning;

alter table public.property_sensor_devices
  add constraint property_sensor_devices_identity_required_after_planning
  check (status = 'planned' or provider_device_id is not null);

comment on column public.property_sensor_devices.provider_device_id is
  'Provider hardware/device identity. Nullable only while a sensor slot remains in planned state.';
