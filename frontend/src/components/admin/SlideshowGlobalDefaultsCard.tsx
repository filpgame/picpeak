/**
 * <SlideshowGlobalDefaultsCard>
 *
 * Global default for the Live Slideshow watermark (the white, semi-transparent
 * corner logo). Every event whose watermark mode is "Use global default"
 * (events.show_watermark = NULL) follows this; events can still override on/off
 * per event. Persisted via PUT /admin/settings/slideshow (app_settings,
 * type 'slideshow').
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { MonitorPlay, Save } from 'lucide-react';
import { Button, Card } from '../common';
import { settingsService } from '../../services/settings.service';
import {
  SLIDESHOW_WATERMARK_POSITIONS,
  SLIDESHOW_WATERMARK_STYLES,
  type SlideshowGlobalDefaults,
} from '../../services/slideshow.service';
import { WatermarkSourcePicker } from './WatermarkSourcePicker';

const DEFAULTS: SlideshowGlobalDefaults = {
  slideshow_watermark_enabled: false,
  slideshow_watermark_source: 'logo',
  slideshow_watermark_position: 'bottom-right',
  slideshow_watermark_opacity: 60,
  slideshow_watermark_style: 'white',
};

const inputClass =
  'w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';

export const SlideshowGlobalDefaultsCard: React.FC = () => {
  const { t } = useTranslation();
  const [val, setVal] = useState<SlideshowGlobalDefaults>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsService.getSettingsByType('slideshow').then((s) => {
      if (cancelled || !s) return;
      setVal({
        slideshow_watermark_enabled: s.slideshow_watermark_enabled ?? DEFAULTS.slideshow_watermark_enabled,
        slideshow_watermark_source: s.slideshow_watermark_source ?? DEFAULTS.slideshow_watermark_source,
        slideshow_watermark_position: s.slideshow_watermark_position ?? DEFAULTS.slideshow_watermark_position,
        slideshow_watermark_opacity: s.slideshow_watermark_opacity ?? DEFAULTS.slideshow_watermark_opacity,
        slideshow_watermark_style: s.slideshow_watermark_style ?? DEFAULTS.slideshow_watermark_style,
      });
    }).catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await settingsService.updateSlideshowDefaults(val);
      toast.success(t('slideshow.defaultsSaved', 'Slideshow defaults saved'));
    } catch {
      toast.error(t('common.error', 'Something went wrong'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="md" className="mb-6">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <MonitorPlay className="w-5 h-5" />
        {t('slideshow.globalTitle', 'Global slideshow watermark')}
      </h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        {t('slideshow.globalDescription', 'Default logo watermark for every slideshow. Individual events can override this on or off.')}
      </p>

      <div className="space-y-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
            checked={val.slideshow_watermark_enabled}
            onChange={(e) => setVal({ ...val, slideshow_watermark_enabled: e.target.checked })}
          />
          <div>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t('slideshow.watermarkToggle', 'Logo watermark')}
            </span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('slideshow.watermarkDescription', 'Overlay a white, semi-transparent logo in a corner (like a TV station ident).')}
            </p>
          </div>
        </label>

        {val.slideshow_watermark_enabled && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>{t('slideshow.watermarkSourceLabel', 'Logo')}</label>
              <WatermarkSourcePicker
                value={val.slideshow_watermark_source}
                onChange={(s) => setVal({ ...val, slideshow_watermark_source: s })}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>{t('slideshow.watermarkPositionLabel', 'Position')}</label>
              <select
                value={val.slideshow_watermark_position}
                onChange={(e) => setVal({ ...val, slideshow_watermark_position: e.target.value as SlideshowGlobalDefaults['slideshow_watermark_position'] })}
                className={inputClass}
              >
                {SLIDESHOW_WATERMARK_POSITIONS.map((pos) => (
                  <option key={pos} value={pos}>
                    {t(`slideshow.watermarkPosition.${pos}`, pos)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkOpacityLabel', 'Opacity (%)')}</label>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={val.slideshow_watermark_opacity}
                onChange={(e) => setVal({ ...val, slideshow_watermark_opacity: Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkStyleLabel', 'Logo style')}</label>
              <select
                value={val.slideshow_watermark_style}
                onChange={(e) => setVal({ ...val, slideshow_watermark_style: e.target.value as SlideshowGlobalDefaults['slideshow_watermark_style'] })}
                className={inputClass}
              >
                {SLIDESHOW_WATERMARK_STYLES.map((st) => (
                  <option key={st} value={st}>
                    {t(`slideshow.watermarkStyle.${st}`, st === 'original' ? 'Original colors' : 'White')}
                  </option>
                ))}
              </select>
            </div>
            </div>
          </div>
        )}

        <Button variant="outline" size="md" leftIcon={<Save className="w-4 h-4" />} onClick={save} isLoading={saving}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </Card>
  );
};

export default SlideshowGlobalDefaultsCard;
