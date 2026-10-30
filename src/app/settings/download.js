// --- START OF FILE src/app/settings/download.js ---
import React from 'react';
import { useAppSettings } from '../../hooks/useAppSettings';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

// 自动下载设置：图片 / 视频 / 文件
export default function DownloadSettingsScreen() {
  const { settings, updateSetting } = useAppSettings();

  return (
    <SettingsPage
      title="自动下载设置"
      footer="自动下载会消耗流量，建议在 Wi-Fi 环境下开启视频与文件。"
    >
      <GroupTitle>自动下载媒体</GroupTitle>
      <Group>
        <SwitchRow
          title="图片"
          desc="收到图片消息时自动下载到本地"
          value={settings.autoDownloadImage}
          onValueChange={(v) => updateSetting('autoDownloadImage', v)}
          isFirst
        />
        <SwitchRow
          title="视频"
          desc="收到视频消息时自动下载，可能消耗较多流量"
          value={settings.autoDownloadVideo}
          onValueChange={(v) => updateSetting('autoDownloadVideo', v)}
        />
        <SwitchRow
          title="文件"
          desc="收到文件消息时自动下载到本地"
          value={settings.autoDownloadFile}
          onValueChange={(v) => updateSetting('autoDownloadFile', v)}
          isLast
        />
      </Group>
    </SettingsPage>
  );
}
// --- END OF FILE src/app/settings/download.js ---
