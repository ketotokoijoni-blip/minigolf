// #/settings (DESIGN §12.1, §12.6). Every change is saved immediately.
import { MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { getSettings, updateSettings, sanitizeName } from '../storage/settings';
import { listCourses, clearCourses, saveDraft } from '../storage/courseLibrary';
import { el, button, field, checkbox, colourPicker, select } from '../ui/components';
import { confirmDialog } from '../ui/dialogs';
import { toast } from '../ui/components';
import { setLanguage, t, type Lang } from '../i18n/t';

function createSettingsScreen(): Screen {
  return {
    mount(root, ctx: ScreenContext) {
      const s = getSettings();

      // Profile
      const nameInput = el('input', { type: 'text', class: 'input', autocomplete: 'nickname', spellcheck: 'false' });
      nameInput.maxLength = MAX_NAME_CHARS;
      nameInput.value = s.name;
      nameInput.addEventListener('change', () => { nameInput.value = updateSettings({ name: sanitizeName(nameInput.value) }).name; });
      const colours = [0, 1, 2, 3].map((c) => t(`colour.${c}`));
      const profile = el('section', { class: 'card stack' },
        el('h3', {}, t('settings.profile')),
        field(t('settings.name'), nameInput, { hint: t('settings.name.hint') }),
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, t('settings.colour')), colourPicker(s.colour, (c) => updateSettings({ colour: c }), colours)),
      );

      // Audio
      const volume = el('input', { type: 'range', min: '0', max: '100', step: '1' });
      volume.value = String(Math.round(s.volume * 100));
      const volumeValue = el('span', { class: 'muted small' }, `${volume.value} %`);
      volume.addEventListener('input', () => {
        volumeValue.textContent = `${volume.value} %`;
        updateSettings({ volume: Number(volume.value) / 100 });
      });
      const audio = el('section', { class: 'card stack' },
        el('h3', {}, t('settings.audio')),
        field(t('settings.volume'), volume),
        volumeValue,
      );

      // General
      const langSelect = select<Lang>([
        { value: 'fi', label: t('settings.language.fi') },
        { value: 'en', label: t('settings.language.en') },
      ], s.language, (lang) => {
        updateSettings({ language: lang });
        document.documentElement.lang = lang;
        setLanguage(lang); // the router re-mounts this screen in the new language
      });
      const general = el('section', { class: 'card stack' },
        el('h3', {}, t('settings.general')),
        field(t('settings.language'), langSelect),
        el('div', { class: 'field' },
          checkbox(t('settings.aimGuide'), s.aimGuide, (v) => updateSettings({ aimGuide: v })),
          el('div', { class: 'field__hint' }, t('settings.aimGuide.hint'))),
        el('div', { class: 'field' },
          checkbox(t('settings.touchFire'), s.touchFireButton, (v) => updateSettings({ touchFireButton: v })),
          el('div', { class: 'field__hint' }, t('settings.touchFire.hint'))),
        el('div', { class: 'field' },
          checkbox(t('settings.reduceEffects'), s.reduceEffects, (v) => updateSettings({ reduceEffects: v })),
          el('div', { class: 'field__hint' }, t('settings.reduceEffects.hint'))),
      );

      // Data
      const countLabel = el('div', { class: 'muted small' });
      const refreshCount = (): void => { countLabel.textContent = t('settings.clearCourses.count', { count: listCourses().length }); };
      refreshCount();
      const clearBtn = button(t('settings.clearCourses'), async () => {
        const count = listCourses().length;
        const ok = await confirmDialog(t('settings.clearCourses.confirm', { count }), { ok: t('common.delete'), danger: true });
        if (!ok) return;
        clearCourses();
        saveDraft(null);
        refreshCount();
        toast(t('settings.clearCourses.done'));
      }, { variant: 'danger' });
      const data = el('section', { class: 'card stack' }, el('h3', {}, t('settings.data')), countLabel, el('div', { class: 'row' }, clearBtn));

      root.append(el('div', { class: 'screen screen--narrow' },
        el('header', { class: 'screen-header' }, button(t('common.back'), () => ctx.navigate('#/')), el('h1', {}, t('settings.title'))),
        el('p', { class: 'muted small' }, t('settings.autosave')),
        profile, audio, general, data,
      ));
    },
    unmount() { /* nothing to release */ },
  };
}

registerScreen('#/settings', createSettingsScreen);
