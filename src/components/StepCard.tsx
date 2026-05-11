import React from 'react';
import { brand } from '../brand.js';

interface StepCardProps {
  n: number;
  title: string;
  completed?: boolean;
  active?: boolean;
  children: React.ReactNode;
}

/**
 * Numbered step card matching the registration app's StepCard visual
 * treatment: purple circle when active, green checkmark when completed,
 * gray when inactive.
 */
export function StepCard({
  n,
  title,
  completed = false,
  active = true,
  children,
}: StepCardProps) {
  const circleStyle: React.CSSProperties = {
    ...styles.stepNumber,
    background: completed
      ? brand.success
      : active
        ? brand.primary
        : brand.cardSurface,
    color: completed || active ? brand.white : brand.textSecondary,
  };

  return (
    <div
      className="step-card"
      style={{
        ...styles.stepCard,
        opacity: active || completed ? 1 : 0.6,
      }}
    >
      <div style={styles.stepHeader}>
        <div style={circleStyle}>
          {completed ? '✓' : n}
        </div>
        <h3 style={styles.stepTitle}>{title}</h3>
      </div>
      <div className="step-content" style={styles.stepContent}>
        {children}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  stepCard: {
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    padding: '28px',
    background:
      'radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
    transition: 'border-color 0.2s, opacity 0.2s, box-shadow 0.2s',
  },
  stepHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginBottom: '16px',
  },
  stepNumber: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 700,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    flexShrink: 0,
    transition: 'background 0.2s',
  },
  stepTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '18px',
    fontWeight: 700,
    color: brand.black,
    margin: 0,
  },
  stepContent: {
    paddingLeft: '52px',
  },
};
