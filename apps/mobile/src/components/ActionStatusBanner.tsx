import React from 'react';
import { Text, View } from 'react-native';

import type { ActionUiRecord } from '../actions/actionExecution';

interface ActionStatusBannerProps {
  record: ActionUiRecord | null;
}

function statusColor(status: ActionUiRecord['status']): string {
  switch (status) {
    case 'pending':
      return '#d29922';
    case 'succeeded':
      return '#238636';
    case 'failed':
      return '#da3633';
    default:
      return '#30363D';
  }
}

export function ActionStatusBanner({ record }: ActionStatusBannerProps) {
  if (!record) {
    return null;
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: statusColor(record.status),
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 10,
        backgroundColor: '#11161b',
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '600' }}>
        Action: {record.kind} • {record.status}
      </Text>
      <Text style={{ color: '#9BA4AE', fontSize: 12 }} numberOfLines={1}>
        Target: {record.targetLabel}
      </Text>
      <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
        {record.message}
      </Text>
    </View>
  );
}
