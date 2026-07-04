"use client";

import { motion, useReducedMotion } from "motion/react";

// Subtle staggered fade-rise for grid items (MOTION 3). Motivated: draws the eye
// down the freshly loaded list. Collapses to instant under reduced-motion.
export function Reveal({ children, index = 0 }: { children: React.ReactNode; index?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.04, 0.4), ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
