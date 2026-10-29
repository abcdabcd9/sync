// --- START OF FILE src/hooks/useAuth.js ---
import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { supabase } from '../services/supabase';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  useEffect(() => {
    // 1. 初始化时获取当前缓存的会话
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user || null);
      setIsAuthLoading(false);
    });

    // 2. 监听全局 Auth 状态变化（登录、登出、Token刷新自动触发）
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user || null);
      setIsAuthLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const value = useMemo(() => ({
    user,
    session,
    isAuthLoading,
    signIn: async (email, password) => await supabase.auth.signInWithPassword({ email, password }),
    signUp: async (email, password) => await supabase.auth.signUp({ email, password }),
    
    // 🍎 核心安全修复：退出登录前，先将数据库中的设备推送令牌抹除，彻底切断幽灵推送！
    signOut: async () => {
      if (user) {
        await supabase.from('profiles').update({ expo_push_token: null }).eq('id', user.id);
      }
      await supabase.auth.signOut();
    },
  }), [user, session, isAuthLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
// --- END OF FILE src/hooks/useAuth.js ---