// src/features/InstitutePanel.tsx
// Panel for managing institutes - view, create, edit, and manage members/invites/classrooms

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useChat } from '@/hooks/useChat';
import {
  useInstitute,
  Institute,
  InstituteMember,
  InstituteInvite,
  Classroom,
  ClassroomMember,
  ClassroomStudent,
  InstituteStudent,
} from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { INSTITUTE_ROLES, CLASSROOM_ROLES } from '@shared/schema';
import { SUPPORTED_LANGUAGES } from '@/i18n/index';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { LicenseBillingCard } from '@/components/billing/LicenseBillingCard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Building2,
  Plus,
  Settings,
  Users,
  Mail,
  MoreHorizontal,
  Crown,
  Trash2,
  Copy,
  RefreshCw,
  UserPlus,
  Clock,
  CheckCircle,
  XCircle,
  LogOut,
  Edit,
  School,
  Hospital,
  Loader2,
  BookOpen,
  GraduationCap,
  UserCheck,
  AlertTriangle,
  Languages,
} from 'lucide-react';

// Grade options for UI - map enum to display labels
const GRADE_OPTIONS = [
  { value: 'pre_k', label: 'Pre-K' },
  { value: 'k', label: 'Kindergarten' },
  { value: '1', label: '1st Grade' },
  { value: '2', label: '2nd Grade' },
  { value: '3', label: '3rd Grade' },
  { value: '4', label: '4th Grade' },
  { value: '5', label: '5th Grade' },
  { value: '6', label: '6th Grade' },
  { value: '7', label: '7th Grade' },
  { value: '8', label: '8th Grade' },
  { value: '9', label: '9th Grade' },
  { value: '10', label: '10th Grade' },
  { value: '11', label: '11th Grade' },
  { value: '12', label: '12th Grade' },
  { value: 'special_ed', label: 'Special Education' },
  { value: 'adult_ed', label: 'Adult Education' },
];

interface InstitutePanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

export function InstitutePanel({ isOpen, onClose }: InstitutePanelProps) {
  const { t, isRTL, language } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { user } = useAuth();
  const { toast } = useToast();
  
  const {
    institutes,
    currentInstitute,
    isLoading,
    selectInstitute,
    createInstitute,
    updateInstitute,
    deleteInstitute,
    leaveInstitute,
    getMembers,
    updateMember,
    removeMember,
    sendInvite,
    getInvites,
    cancelInvite,
    resendInvite,
    refetchInstitutes,
    // Classroom operations
    getClassrooms,
    createClassroom,
    updateClassroom,
    deleteClassroom,
    getClassroomMembers,
    addClassroomMember,
    updateClassroomMember,
    removeClassroomMember,
    getClassroomStudents,
    addStudentToClassroom,
    updateClassroomStudent,
    removeStudentFromClassroom,
    // Institute student operations
    getInstituteStudents,
    addStudentToInstitute,
    updateInstituteStudent,
    removeStudentFromInstitute,
  } = useInstitute();

  // Get user's students for adding to institute
  const { students: userStudents } = useStudent();

  // Get AI refresh state to show loading indicator when AI updates data
  const { aiRefreshing } = useChat();
  const isAiRefreshing = aiRefreshing.has('institute');

  // Local state
  const [activeTab, setActiveTab] = useState<'overview' | 'members' | 'classrooms' | 'students' | 'invites' | 'settings'>('overview');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  
  // Classroom dialogs
  const [showClassroomDialog, setShowClassroomDialog] = useState(false);
  const [showClassroomMemberDialog, setShowClassroomMemberDialog] = useState(false);
  const [showClassroomStudentDialog, setShowClassroomStudentDialog] = useState(false);
  const [showClassroomDeleteConfirm, setShowClassroomDeleteConfirm] = useState(false);
  const [selectedClassroom, setSelectedClassroom] = useState<Classroom | null>(null);
  const [editingClassroom, setEditingClassroom] = useState<Classroom | null>(null);
  
  const [members, setMembers] = useState<InstituteMember[]>([]);
  const [invites, setInvites] = useState<InstituteInvite[]>([]);
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [classroomMembers, setClassroomMembers] = useState<ClassroomMember[]>([]);
  const [classroomStudents, setClassroomStudents] = useState<ClassroomStudent[]>([]);
  const [instituteStudents, setInstituteStudents] = useState<InstituteStudent[]>([]);
  
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [loadingClassrooms, setLoadingClassrooms] = useState(false);
  const [loadingClassroomMembers, setLoadingClassroomMembers] = useState(false);
  const [loadingClassroomStudents, setLoadingClassroomStudents] = useState(false);
  const [loadingInstituteStudents, setLoadingInstituteStudents] = useState(false);

  // Form state - Institute create with role selection
  const [createForm, setCreateForm] = useState({
    name: '',
    type: 'school' as 'school' | 'clinic',
    description: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    instituteIdNumber: '',
    instituteIdType: '',
    language: 'en',
    creatorRole: 'admin' as string,
  });
  const [editForm, setEditForm] = useState<Partial<Institute>>({});
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({
    email: '',
    role: 'staff',
    grantAdmin: false,
    message: '',
  });
  
  // Classroom form state
  const [classroomForm, setClassroomForm] = useState({
    name: '',
    grade: '',
    description: '',
    capacity: '',
    roomNumber: '',
    academicYear: '',
  });
  
  // Classroom member form
  const [classroomMemberForm, setClassroomMemberForm] = useState({
    userId: '',
    role: 'aide' as string,
    isPrimary: false,
  });
  
  // Classroom student form
  const [classroomStudentForm, setClassroomStudentForm] = useState({
    studentId: '',
    isPrimary: true,
    notes: '',
  });

  // Institute student dialogs
  const [showAddInstituteStudentDialog, setShowAddInstituteStudentDialog] = useState(false);
  const [showEditInstituteStudentDialog, setShowEditInstituteStudentDialog] = useState(false);
  const [showRemoveInstituteStudentConfirm, setShowRemoveInstituteStudentConfirm] = useState(false);
  const [selectedInstituteStudent, setSelectedInstituteStudent] = useState<InstituteStudent | null>(null);

  // Institute student form
  const [instituteStudentForm, setInstituteStudentForm] = useState({
    studentId: '',
    grade: '',
    idNumber: '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load data based on active tab
  useEffect(() => {
    if (currentInstitute && activeTab === 'members') {
      loadMembers();
    }
  }, [currentInstitute, activeTab]);

  useEffect(() => {
    if (currentInstitute && activeTab === 'invites') {
      loadInvites();
    }
  }, [currentInstitute, activeTab]);

  useEffect(() => {
    if (currentInstitute && activeTab === 'classrooms' && currentInstitute.type === 'school') {
      loadClassrooms();
    }
  }, [currentInstitute, activeTab]);

  useEffect(() => {
    if (currentInstitute && activeTab === 'students') {
      loadInstituteStudents();
    }
  }, [currentInstitute, activeTab]);

  // Re-fetch sub-entity data when AI updates institute data
  useEffect(() => {
    if (!isAiRefreshing || !currentInstitute) return;
    // Refetch the main institutes list
    refetchInstitutes();
    // Refetch whatever sub-entity data the current tab displays
    if (activeTab === 'members') loadMembers();
    if (activeTab === 'invites') loadInvites();
    if (activeTab === 'classrooms') loadClassrooms();
    if (activeTab === 'students') loadInstituteStudents();
    if (selectedClassroom) {
      loadClassroomMembers(selectedClassroom.id);
      loadClassroomStudents(selectedClassroom.id);
    }
  }, [isAiRefreshing]);

  // Load classroom details when selected
  useEffect(() => {
    if (selectedClassroom) {
      loadClassroomMembers(selectedClassroom.id);
      loadClassroomStudents(selectedClassroom.id);
    }
  }, [selectedClassroom]);

  const loadMembers = async () => {
    if (!currentInstitute) return;
    setLoadingMembers(true);
    try {
      const membersList = await getMembers(currentInstitute.id);
      setMembers(membersList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingMembers(false);
    }
  };

  const loadInvites = async () => {
    if (!currentInstitute) return;
    setLoadingInvites(true);
    try {
      const invitesList = await getInvites(currentInstitute.id);
      setInvites(invitesList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingInvites(false);
    }
  };

  const loadClassrooms = async () => {
    if (!currentInstitute) return;
    setLoadingClassrooms(true);
    try {
      const classroomsList = await getClassrooms(currentInstitute.id);
      setClassrooms(classroomsList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingClassrooms(false);
    }
  };

  const loadClassroomMembers = async (classroomId: string) => {
    setLoadingClassroomMembers(true);
    try {
      const membersList = await getClassroomMembers(classroomId);
      setClassroomMembers(membersList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingClassroomMembers(false);
    }
  };

  const loadClassroomStudents = async (classroomId: string) => {
    setLoadingClassroomStudents(true);
    try {
      const studentsList = await getClassroomStudents(classroomId);
      setClassroomStudents(studentsList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingClassroomStudents(false);
    }
  };

  const loadInstituteStudents = async () => {
    if (!currentInstitute) return;
    setLoadingInstituteStudents(true);
    try {
      const studentsList = await getInstituteStudents(currentInstitute.id);
      setInstituteStudents(studentsList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingInstituteStudents(false);
    }
  };

  // ==========================================================================
  // INSTITUTE HANDLERS
  // ==========================================================================

  const handleCreateInstitute = async () => {
    if (!createForm.name.trim()) {
      toast({
        title: t('institute.error') || 'Error',
        description: t('institute.nameRequired') || 'Name is required',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { creatorRole, ...instituteData } = createForm;
      const newInstitute = await createInstitute({ ...instituteData, creatorRole });
      selectInstitute(newInstitute.id);
      setShowCreateDialog(false);
      setCreateForm({
        name: '',
        type: 'school',
        description: '',
        address: '',
        phone: '',
        email: '',
        website: '',
        instituteIdNumber: '',
        instituteIdType: '',
        language: 'en',
        creatorRole: 'admin',
      });
      toast({
        title: t('institute.created') || 'Institute Created',
        description: t('institute.createdDesc') || 'Your institute has been created successfully.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateInstitute = async () => {
    if (!currentInstitute) return;

    setIsSubmitting(true);
    try {
      await updateInstitute(currentInstitute.id, editForm, logoFile || undefined);
      setShowEditDialog(false);
      setLogoFile(null);
      setLogoPreview(null);
      toast({
        title: t('institute.updated') || 'Institute Updated',
        description: t('institute.updatedDesc') || 'Changes saved successfully.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteInstitute = async () => {
    if (!currentInstitute) return;

    setIsSubmitting(true);
    try {
      await deleteInstitute(currentInstitute.id);
      setShowDeleteConfirm(false);
      toast({
        title: t('institute.deleted') || 'Institute Deleted',
        description: t('institute.deletedDesc') || 'The institute has been deleted.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLeaveInstitute = async () => {
    if (!currentInstitute) return;

    setIsSubmitting(true);
    try {
      await leaveInstitute(currentInstitute.id);
      setShowLeaveConfirm(false);
      toast({
        title: t('institute.left') || 'Left Institute',
        description: t('institute.leftDesc') || 'You have left the institute.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendInvite = async () => {
    if (!currentInstitute || !inviteForm.email.trim()) {
      toast({
        title: t('institute.error') || 'Error',
        description: t('institute.emailRequired') || 'Email is required',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { inviteLink } = await sendInvite(currentInstitute.id, inviteForm.email, {
        role: inviteForm.role,
        grantAdmin: inviteForm.grantAdmin,
        message: inviteForm.message || undefined,
      });
      
      await navigator.clipboard.writeText(inviteLink);
      
      setShowInviteDialog(false);
      setInviteForm({ email: '', role: 'staff', grantAdmin: false, message: '' });
      loadInvites();
      
      toast({
        title: t('institute.inviteSent') || 'Invite Sent',
        description: t('institute.inviteSentDesc') || 'The invite link has been copied to your clipboard.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    if (!currentInstitute) return;

    try {
      await cancelInvite(currentInstitute.id, inviteId);
      loadInvites();
      toast({
        title: t('institute.inviteCancelled') || 'Invite Cancelled',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    if (!currentInstitute) return;

    try {
      const { inviteLink } = await resendInvite(currentInstitute.id, inviteId);
      await navigator.clipboard.writeText(inviteLink);
      loadInvites();
      toast({
        title: t('institute.inviteResent') || 'Invite Resent',
        description: t('institute.inviteLinkCopied') || 'New invite link copied to clipboard.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleToggleAdmin = async (memberId: string, isCurrentlyAdmin: boolean) => {
    if (!currentInstitute) return;

    try {
      await updateMember(currentInstitute.id, memberId, { isAdmin: !isCurrentlyAdmin });
      loadMembers();
      toast({
        title: t('institute.memberUpdated') || 'Member Updated',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleUpdateMemberRole = async (memberId: string, role: string) => {
    if (!currentInstitute) return;

    try {
      await updateMember(currentInstitute.id, memberId, { role });
      loadMembers();
      toast({
        title: t('institute.memberUpdated') || 'Member Updated',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!currentInstitute) return;

    try {
      await removeMember(currentInstitute.id, memberId);
      loadMembers();
      toast({
        title: t('institute.memberRemoved') || 'Member Removed',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  // ==========================================================================
  // CLASSROOM HANDLERS
  // ==========================================================================

  const handleCreateClassroom = async () => {
    if (!currentInstitute || !classroomForm.name.trim()) {
      toast({
        title: t('institute.error') || 'Error',
        description: t('classroom.nameRequired') || 'Classroom name is required',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await createClassroom(currentInstitute.id, {
        name: classroomForm.name,
        grade: classroomForm.grade || undefined,
        description: classroomForm.description || undefined,
        capacity: classroomForm.capacity ? parseInt(classroomForm.capacity) : undefined,
        roomNumber: classroomForm.roomNumber || undefined,
        academicYear: classroomForm.academicYear || undefined,
      });
      
      setShowClassroomDialog(false);
      setClassroomForm({ name: '', grade: '', description: '', capacity: '', roomNumber: '', academicYear: '' });
      setEditingClassroom(null);
      loadClassrooms();
      
      toast({
        title: t('classroom.created') || 'Classroom Created',
        description: t('classroom.createdDesc') || 'The classroom has been created successfully.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateClassroom = async () => {
    if (!editingClassroom || !classroomForm.name.trim()) {
      return;
    }

    setIsSubmitting(true);
    try {
      // null, not undefined: this is a PATCH that merges by key, and
      // JSON.stringify drops undefined — a cleared field would never be sent
      // and the old value would come back on the next load.
      await updateClassroom(editingClassroom.id, {
        name: classroomForm.name,
        grade: classroomForm.grade || null,
        description: classroomForm.description || null,
        capacity: classroomForm.capacity ? parseInt(classroomForm.capacity) : null,
        roomNumber: classroomForm.roomNumber || null,
        academicYear: classroomForm.academicYear || null,
      });
      
      setShowClassroomDialog(false);
      setClassroomForm({ name: '', grade: '', description: '', capacity: '', roomNumber: '', academicYear: '' });
      setEditingClassroom(null);
      loadClassrooms();
      
      // Refresh selected classroom if it was the one edited
      if (selectedClassroom?.id === editingClassroom.id) {
        const updated = await getClassrooms(currentInstitute!.id);
        const refreshed = updated.find((c: Classroom) => c.id === editingClassroom.id);
        if (refreshed) setSelectedClassroom(refreshed);
      }
      
      toast({
        title: t('classroom.updated') || 'Classroom Updated',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteClassroom = async () => {
    if (!selectedClassroom) return;

    setIsSubmitting(true);
    try {
      await deleteClassroom(selectedClassroom.id);
      setShowClassroomDeleteConfirm(false);
      setSelectedClassroom(null);
      loadClassrooms();
      
      toast({
        title: t('classroom.deleted') || 'Classroom Deleted',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddClassroomMember = async () => {
    if (!selectedClassroom || !classroomMemberForm.userId) {
      return;
    }

    setIsSubmitting(true);
    try {
      await addClassroomMember(selectedClassroom.id, 
        classroomMemberForm.userId,
        classroomMemberForm.role,
        classroomMemberForm.isPrimary,
      );
      
      setShowClassroomMemberDialog(false);
      setClassroomMemberForm({ userId: '', role: 'aide', isPrimary: false });
      loadClassroomMembers(selectedClassroom.id);
      
      toast({
        title: t('classroom.memberAdded') || 'Member Added',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveClassroomMember = async (userId: string) => {
    if (!selectedClassroom) return;

    try {
      await removeClassroomMember(selectedClassroom.id, userId);
      loadClassroomMembers(selectedClassroom.id);
      toast({
        title: t('classroom.memberRemoved') || 'Member Removed',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleAddClassroomStudent = async () => {
    if (!selectedClassroom || !classroomStudentForm.studentId) {
      return;
    }

    setIsSubmitting(true);
    try {
      await addStudentToClassroom(selectedClassroom.id, classroomStudentForm.studentId, {
        isPrimary: classroomStudentForm.isPrimary,
        notes: classroomStudentForm.notes || undefined,
      });
      
      setShowClassroomStudentDialog(false);
      setClassroomStudentForm({ studentId: '', isPrimary: true, notes: '' });
      loadClassroomStudents(selectedClassroom.id);
      
      toast({
        title: t('classroom.studentAdded') || 'Student Added',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveClassroomStudent = async (studentId: string) => {
    if (!selectedClassroom) return;

    try {
      await removeStudentFromClassroom(selectedClassroom.id, studentId);
      loadClassroomStudents(selectedClassroom.id);
      toast({
        title: t('classroom.studentRemoved') || 'Student Removed',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  // ==========================================================================
  // INSTITUTE STUDENT HANDLERS
  // ==========================================================================

  const handleAddInstituteStudent = async () => {
    if (!currentInstitute || !instituteStudentForm.studentId) {
      toast({
        title: t('institute.error') || 'Error',
        description: t('institute.selectStudent') || 'Please select a student',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await addStudentToInstitute(currentInstitute.id, instituteStudentForm.studentId, {
        grade: instituteStudentForm.grade || undefined,
        idNumber: instituteStudentForm.idNumber || undefined,
      });
      await loadInstituteStudents();
      setShowAddInstituteStudentDialog(false);
      setInstituteStudentForm({ studentId: '', grade: '', idNumber: '' });
      toast({
        title: t('institute.studentAdded') || 'Student Added',
        description: t('institute.studentAddedDesc') || 'Student has been added to the institute.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditInstituteStudent = async () => {
    if (!currentInstitute || !selectedInstituteStudent) return;

    setIsSubmitting(true);
    try {
      // null, not undefined — a PATCH merge drops undefined keys, so a cleared
      // grade / ID number would silently keep its previous value.
      await updateInstituteStudent(currentInstitute.id, selectedInstituteStudent.id, {
        grade: instituteStudentForm.grade || null,
        idNumber: instituteStudentForm.idNumber || null,
      });
      await loadInstituteStudents();
      setShowEditInstituteStudentDialog(false);
      setSelectedInstituteStudent(null);
      setInstituteStudentForm({ studentId: '', grade: '', idNumber: '' });
      toast({
        title: t('institute.studentUpdated') || 'Student Updated',
        description: t('institute.studentUpdatedDesc') || 'Student enrollment has been updated.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveInstituteStudent = async () => {
    if (!currentInstitute || !selectedInstituteStudent) return;

    setIsSubmitting(true);
    try {
      await removeStudentFromInstitute(currentInstitute.id, selectedInstituteStudent.id);
      await loadInstituteStudents();
      setShowRemoveInstituteStudentConfirm(false);
      setSelectedInstituteStudent(null);
      toast({
        title: t('institute.studentRemoved') || 'Student Removed',
        description: t('institute.studentRemovedDesc') || 'Student has been removed from the institute.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditInstituteStudentDialog = (student: InstituteStudent) => {
    setSelectedInstituteStudent(student);
    setInstituteStudentForm({
      studentId: student.id,
      grade: student.grade || '',
      idNumber: student.idNumber || '',
    });
    setShowEditInstituteStudentDialog(true);
  };

  const openRemoveInstituteStudentConfirm = (student: InstituteStudent) => {
    setSelectedInstituteStudent(student);
    setShowRemoveInstituteStudentConfirm(true);
  };

  // Get students available to add (user's students not already in this institute)
  const availableStudentsToAdd = userStudents.filter(
    (student) => !instituteStudents.some((is) => is.id === student.id)
  );

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  const openEditDialog = () => {
    if (currentInstitute) {
      setEditForm({
        name: currentInstitute.name,
        type: currentInstitute.type,
        description: currentInstitute.description || '',
        address: currentInstitute.address || '',
        phone: currentInstitute.phone || '',
        email: currentInstitute.email || '',
        website: currentInstitute.website || '',
        language: currentInstitute.language || '',
        timezone: currentInstitute.timezone || '',
      });
      setShowEditDialog(true);
    }
  };

  const openClassroomDialog = (classroom?: Classroom) => {
    if (classroom) {
      setEditingClassroom(classroom);
      setClassroomForm({
        name: classroom.name,
        grade: classroom.grade || '',
        description: classroom.description || '',
        capacity: classroom.capacity?.toString() || '',
        roomNumber: classroom.roomNumber || '',
        academicYear: classroom.academicYear || '',
      });
    } else {
      setEditingClassroom(null);
      setClassroomForm({ name: '', grade: '', description: '', capacity: '', roomNumber: '', academicYear: '' });
    }
    setShowClassroomDialog(true);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: any }> = {
      pending: { variant: 'secondary', icon: Clock },
      accepted: { variant: 'default', icon: CheckCircle },
      declined: { variant: 'destructive', icon: XCircle },
      expired: { variant: 'outline', icon: Clock },
      cancelled: { variant: 'outline', icon: XCircle },
    };
    const config = statusConfig[status] || statusConfig.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className="gap-1">
        <Icon className="w-3 h-3" />
        {t(`institute.status.${status}`) || status}
      </Badge>
    );
  };

  const getGradeLabel = (gradeValue: string) => {
    const grade = GRADE_OPTIONS.find(g => g.value === gradeValue);
    return grade?.label || gradeValue;
  };

  const getRoleLabel = (roleValue: string, type: 'institute' | 'classroom') => {
    const roles = type === 'institute' ? INSTITUTE_ROLES : CLASSROOM_ROLES;
    const role = roles.find((r: any) => r.value === roleValue);
    return role ? (t(role.labelKey) || roleValue) : roleValue;
  };

  // Filter members who aren't already in the classroom
  const getAvailableMembers = () => {
    const classroomMemberIds = new Set(classroomMembers.map(m => m.id));
    return members.filter(m => !classroomMemberIds.has(m.id));
  };

  // Filter students who aren't already in the classroom
  const getAvailableStudents = () => {
    const classroomStudentIds = new Set(classroomStudents.map(s => s.id));
    return instituteStudents.filter(s => !classroomStudentIds.has(s.id));
  };

  if (!isOpen) return null;

  // No institute selected - show list or create prompt
  if (!currentInstitute) {
    return (
      <div
        dir={isRTL ? 'rtl' : 'ltr'}
        className={cn(
          'flex flex-col h-full min-h-0',
          isDark ? 'bg-slate-950' : 'bg-gray-50'
        )}
      >
        {/* Header */}
        <div className={cn(
          'p-4 border-b shrink-0',
          isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
        )}>
          <div className="flex justify-between items-center">
            <div>
              <div className="flex items-center gap-2">
                <h1 className={cn(
                  'text-xl font-bold',
                  isDark ? 'text-white' : 'text-slate-900'
                )}>
                  {t('institute.title') || 'Institutes'}
                </h1>
                {isAiRefreshing && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className={cn(
                'text-sm',
                isDark ? 'text-slate-400' : 'text-slate-600'
              )}>
                {t('institute.subtitle') || 'Manage your organization memberships'}
              </p>
            </div>
            <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              {t('institute.create') || 'Create Institute'}
            </Button>
          </div>
        </div>

        {/* Institute List */}
        <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="flex-1">
          <div className="p-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : institutes.length === 0 ? (
              <div className="text-center py-12">
                <Building2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className={cn(
                  'text-lg font-medium mb-2',
                  isDark ? 'text-slate-300' : 'text-slate-700'
                )}>
                  {t('institute.noInstitutes') || 'No institutes yet'}
                </p>
                <p className="text-sm text-muted-foreground mb-4">
                  {t('institute.noInstitutesDesc') || 'Create an institute to manage your organization.'}
                </p>
                <Button onClick={() => setShowCreateDialog(true)}>
                  <Plus className="w-4 h-4 me-2" />
                  {t('institute.createFirst') || 'Create Your First Institute'}
                </Button>
              </div>
            ) : (
              institutes.map((institute) => (
                <Card
                  key={institute.id}
                  className={cn(
                    'cursor-pointer transition-all hover:shadow-md',
                    isDark ? 'hover:border-slate-600' : 'hover:border-slate-300'
                  )}
                  onClick={() => selectInstitute(institute.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'p-2 rounded-lg',
                          institute.type === 'school'
                            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                        )}>
                          {institute.type === 'school' ? <School className="w-5 h-5" /> : <Hospital className="w-5 h-5" />}
                        </div>
                        <div>
                          <h3 className="font-medium">{institute.name}</h3>
                          <p className="text-sm text-muted-foreground">
                            {t(`institute.type.${institute.type}`) || institute.type}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {institute.isAdmin && (
                          <Badge variant="secondary" className="gap-1">
                            <Crown className="w-3 h-3" />
                            {t('institute.admin') || 'Admin'}
                          </Badge>
                        )}
                        {institute.role && (
                          <Badge variant="outline">
                            {getRoleLabel(institute.role, 'institute')}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Create Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>{t('institute.create') || 'Create Institute'}</DialogTitle>
              <DialogDescription>
                {t('institute.createDesc') || 'Create a new institute to manage your organization.'}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">{t('institute.name') || 'Name'} *</Label>
                <Input
                  id="name"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder={t('institute.namePlaceholder') || 'Enter institute name'}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="type">{t('institute.typeLabel') || 'Type'}</Label>
                <Select
                  value={createForm.type}
                  onValueChange={(value: 'school' | 'clinic') => setCreateForm({ ...createForm, type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="school">
                      <span className="flex items-center gap-2">
                        <School className="w-4 h-4" />
                        {t('institute.type.school') || 'School'}
                      </span>
                    </SelectItem>
                    <SelectItem value="clinic">
                      <span className="flex items-center gap-2">
                        <Hospital className="w-4 h-4" />
                        {t('institute.type.clinic') || 'Clinic'}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="creatorRole">{t('institute.yourRole') || 'Your Role'}</Label>
                <Select
                  value={createForm.creatorRole}
                  onValueChange={(value) => setCreateForm({ ...createForm, creatorRole: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INSTITUTE_ROLES.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {t(role.labelKey) || role.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('institute.creatorRoleNote') || 'You will be an admin regardless of the role selected.'}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">{t('institute.description') || 'Description'}</Label>
                <Textarea
                  id="description"
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  placeholder={t('institute.descriptionPlaceholder') || 'Brief description of the institute'}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="createIdNumber">{t('institute.idNumber') || 'Institute ID'}</Label>
                  <Input
                    id="createIdNumber"
                    dir="ltr"
                    value={createForm.instituteIdNumber}
                    onChange={(e) => setCreateForm({ ...createForm, instituteIdNumber: e.target.value })}
                    placeholder={t('institute.idNumberPlaceholder') || 'e.g. 123456'}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="createIdType">{t('institute.idType') || 'ID Type'}</Label>
                  <Input
                    id="createIdType"
                    value={createForm.instituteIdType}
                    onChange={(e) => setCreateForm({ ...createForm, instituteIdType: e.target.value })}
                    placeholder={t('institute.idTypePlaceholder') || 'e.g. MOE, MOH'}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="createLanguage">{t('institute.language') || 'Language'}</Label>
                <Select
                  value={createForm.language}
                  onValueChange={(value) => setCreateForm({ ...createForm, language: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('institute.languagePlaceholder') || 'Select language...'} />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        <span className="flex items-center gap-2">
                          <Languages className="w-4 h-4" />
                          {lang.name} ({lang.nativeName})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                {t('common.cancel') || 'Cancel'}
              </Button>
              <Button onClick={handleCreateInstitute} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                {t('common.create') || 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Institute selected - show details with tabs
  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}
    >
      {/* Header */}
      <div className={cn(
        'p-4 border-b shrink-0',
        isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
      )}>
        <div className="flex items-center gap-4 mb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectInstitute(null)}
          >
            {t('common.back') || '← Back'}
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className={cn(
                'text-xl font-bold',
                isDark ? 'text-white' : 'text-slate-900'
              )}>
                {currentInstitute.name}
              </h1>
              {currentInstitute.isAdmin && (
                <Badge variant="secondary" className="gap-1">
                  <Crown className="w-3 h-3" />
                  {t('institute.admin') || 'Admin'}
                </Badge>
              )}
              {isAiRefreshing && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {t(`institute.type.${currentInstitute.type}`) || currentInstitute.type}
            </p>
          </div>
          {currentInstitute.isAdmin ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Institute actions">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                <DropdownMenuItem onClick={openEditDialog}>
                  <Edit className="w-4 h-4 me-2" />
                  {t('institute.edit') || 'Edit Details'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  <Trash2 className="w-4 h-4 me-2" />
                  {t('institute.delete') || 'Delete Institute'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLeaveConfirm(true)}
            >
              <LogOut className="w-4 h-4 me-2" />
              {t('institute.leave') || 'Leave'}
            </Button>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList>
            <TabsTrigger value="overview">
              {t('institute.tabs.overview') || 'Overview'}
            </TabsTrigger>
            <TabsTrigger value="members">
              {t('institute.tabs.members') || 'Members'}
            </TabsTrigger>
            {currentInstitute.type === 'school' && (
              <TabsTrigger value="classrooms">
                {t('institute.tabs.classrooms') || 'Classrooms'}
              </TabsTrigger>
            )}
            <TabsTrigger value="students">
              {t('institute.tabs.students') || 'Students'}
            </TabsTrigger>
            {currentInstitute.isAdmin && (
              <TabsTrigger value="invites">
                {t('institute.tabs.invites') || 'Invites'}
              </TabsTrigger>
            )}
            {currentInstitute.isAdmin && (
              <TabsTrigger value="settings">
                {t('institute.tabs.settings') || 'Settings'}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>

      {/* Content */}
      <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="flex-1">
        <div className="p-4">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* License & billing. Self-hiding: renders nothing for a
                  perpetual license, and shows status without a pay button for
                  invoice customers and non-admin members. */}
              <LicenseBillingCard scope="institute" />
              <Card>
                <CardHeader>
                  <CardTitle>{t('institute.details') || 'Details'}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {currentInstitute.description && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.description') || 'Description'}</Label>
                      <p>{currentInstitute.description}</p>
                    </div>
                  )}
                  {currentInstitute.address && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.address') || 'Address'}</Label>
                      <p>{currentInstitute.address}</p>
                    </div>
                  )}
                  {currentInstitute.phone && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.phone') || 'Phone'}</Label>
                      <p dir="ltr">{currentInstitute.phone}</p>
                    </div>
                  )}
                  {currentInstitute.email && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.email') || 'Email'}</Label>
                      <p dir="ltr">{currentInstitute.email}</p>
                    </div>
                  )}
                  {currentInstitute.website && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.website') || 'Website'}</Label>
                      <p dir="ltr">
                        <a href={currentInstitute.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          {currentInstitute.website}
                        </a>
                      </p>
                    </div>
                  )}
                  {currentInstitute.instituteIdNumber && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.idNumber') || 'Institute ID'}</Label>
                      <p dir="ltr">
                        {currentInstitute.instituteIdNumber}
                        {currentInstitute.instituteIdType && (
                          <span className="text-muted-foreground ms-2">({currentInstitute.instituteIdType})</span>
                        )}
                      </p>
                    </div>
                  )}
                  {currentInstitute.language && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.language') || 'Language'}</Label>
                      <p>{SUPPORTED_LANGUAGES.find(l => l.code === currentInstitute.language)?.name || currentInstitute.language}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Members Tab */}
          {activeTab === 'members' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">{t('institute.members') || 'Members'}</h2>
                {currentInstitute.isAdmin && (
                  <Button onClick={() => setShowInviteDialog(true)}>
                    <UserPlus className="w-4 h-4 me-2" />
                    {t('institute.inviteMember') || 'Invite Member'}
                  </Button>
                )}
              </div>
              
              {loadingMembers ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : members.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center">
                    <Users className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">{t('institute.noMembers') || 'No members yet'}</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {members.map((member) => (
                    <Card key={member.id}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {member.profileImageUrl ? (
                              <img
                                src={member.profileImageUrl}
                                alt={member.fullName || member.email}
                                className="w-10 h-10 rounded-full object-cover"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                                <Users className="w-5 h-5 text-muted-foreground" />
                              </div>
                            )}
                            <div>
                              <p className="font-medium">{member.fullName || member.email}</p>
                              <p className="text-sm text-muted-foreground">{member.email}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {member.isAdmin && (
                              <Badge variant="secondary" className="gap-1">
                                <Crown className="w-3 h-3" />
                                {t('institute.admin') || 'Admin'}
                              </Badge>
                            )}
                            <Badge variant="outline">
                              {getRoleLabel(member.role, 'institute')}
                            </Badge>
                            {currentInstitute.isAdmin && member.id !== user?.id && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label="Member actions">
                                    <MoreHorizontal className="w-4 h-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                                  <DropdownMenuLabel>{t('institute.changeRole') || 'Change Role'}</DropdownMenuLabel>
                                  {INSTITUTE_ROLES.map((role) => (
                                    <DropdownMenuItem
                                      key={role.value}
                                      onClick={() => handleUpdateMemberRole(member.membershipId, role.value)}
                                    >
                                      {member.role === role.value && <CheckCircle className="w-4 h-4 me-2" />}
                                      {t(role.labelKey) || role.value}
                                    </DropdownMenuItem>
                                  ))}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => handleToggleAdmin(member.membershipId, member.isAdmin)}>
                                    {member.isAdmin ? (
                                      <>
                                        <XCircle className="w-4 h-4 me-2" />
                                        {t('institute.removeAdmin') || 'Remove Admin'}
                                      </>
                                    ) : (
                                      <>
                                        <Crown className="w-4 h-4 me-2" />
                                        {t('institute.makeAdmin') || 'Make Admin'}
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onClick={() => handleRemoveMember(member.membershipId)}
                                  >
                                    <Trash2 className="w-4 h-4 me-2" />
                                    {t('institute.removeMember') || 'Remove'}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                            {/* Allow admins to edit their own role */}
                            {currentInstitute.isAdmin && member.id === user?.id && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label="Edit your role">
                                    <MoreHorizontal className="w-4 h-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                                  <DropdownMenuLabel>{t('institute.changeRole') || 'Change Role'}</DropdownMenuLabel>
                                  {INSTITUTE_ROLES.map((role) => (
                                    <DropdownMenuItem
                                      key={role.value}
                                      onClick={() => handleUpdateMemberRole(member.membershipId, role.value)}
                                    >
                                      {member.role === role.value && <CheckCircle className="w-4 h-4 me-2" />}
                                      {t(role.labelKey) || role.value}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Classrooms Tab - Only for schools */}
          {activeTab === 'classrooms' && currentInstitute.type === 'school' && (
            <div className="space-y-4">
              {!selectedClassroom ? (
                // Classroom list view
                <>
                  <div className="flex justify-between items-center">
                    <h2 className="text-lg font-semibold">{t('classroom.title') || 'Classrooms'}</h2>
                    {currentInstitute.isAdmin && (
                      <Button onClick={() => openClassroomDialog()}>
                        <Plus className="w-4 h-4 me-2" />
                        {t('classroom.create') || 'Create Classroom'}
                      </Button>
                    )}
                  </div>

                  {loadingClassrooms ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : classrooms.length === 0 ? (
                    <Card>
                      <CardContent className="py-8 text-center">
                        <BookOpen className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                        <p className="text-muted-foreground">{t('classroom.noClassrooms') || 'No classrooms yet'}</p>
                        {currentInstitute.isAdmin && (
                          <Button className="mt-4" onClick={() => openClassroomDialog()}>
                            <Plus className="w-4 h-4 me-2" />
                            {t('classroom.createFirst') || 'Create Your First Classroom'}
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {classrooms.map((classroom) => (
                        <Card
                          key={classroom.id}
                          className="cursor-pointer transition-all hover:shadow-md"
                          onClick={() => setSelectedClassroom(classroom)}
                        >
                          <CardHeader className="pb-2">
                            <div className="flex items-start justify-between">
                              <div>
                                <CardTitle className="text-base">{classroom.name}</CardTitle>
                                {classroom.grade && (
                                  <CardDescription>{getGradeLabel(classroom.grade)}</CardDescription>
                                )}
                              </div>
                              <Badge variant="outline">
                                <BookOpen className="w-3 h-3 me-1" />
                                {classroom.roomNumber || '-'}
                              </Badge>
                            </div>
                          </CardHeader>
                          <CardContent>
                            {classroom.description && (
                              <p className="text-sm text-muted-foreground line-clamp-2">{classroom.description}</p>
                            )}
                            <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                              {classroom.capacity && (
                                <span className="flex items-center gap-1">
                                  <Users className="w-3 h-3" />
                                  {t('classroom.capacity') || 'Capacity'}: {classroom.capacity}
                                </span>
                              )}
                              {classroom.academicYear && (
                                <span className="flex items-center gap-1">
                                  <GraduationCap className="w-3 h-3" />
                                  {classroom.academicYear}
                                </span>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                // Single classroom detail view
                <>
                  <div className="flex items-center gap-4 mb-4">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedClassroom(null)}>
                      {t('common.back') || '← Back'}
                    </Button>
                    <div className="flex-1">
                      <h2 className="text-lg font-semibold">{selectedClassroom.name}</h2>
                      {selectedClassroom.grade && (
                        <p className="text-sm text-muted-foreground">{getGradeLabel(selectedClassroom.grade)}</p>
                      )}
                    </div>
                    {currentInstitute.isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="icon" aria-label="Classroom actions">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                          <DropdownMenuItem onClick={() => openClassroomDialog(selectedClassroom)}>
                            <Edit className="w-4 h-4 me-2" />
                            {t('classroom.edit') || 'Edit Classroom'}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setShowClassroomDeleteConfirm(true)}
                          >
                            <Trash2 className="w-4 h-4 me-2" />
                            {t('classroom.delete') || 'Delete Classroom'}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {/* Classroom Info */}
                  {selectedClassroom.description && (
                    <Card className="mb-4">
                      <CardContent className="py-3">
                        <p className="text-sm">{selectedClassroom.description}</p>
                      </CardContent>
                    </Card>
                  )}

                  {/* Classroom Members Section */}
                  <Card className="mb-4">
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-center">
                        <CardTitle className="text-base">{t('classroom.members') || 'Assigned Staff'}</CardTitle>
                        {currentInstitute.isAdmin && (
                          <Button size="sm" onClick={() => {
                            loadMembers(); // Make sure members list is fresh
                            setShowClassroomMemberDialog(true);
                          }}>
                            <UserPlus className="w-4 h-4 me-2" />
                            {t('classroom.addMember') || 'Add Staff'}
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      {loadingClassroomMembers ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : classroomMembers.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          {t('classroom.noMembers') || 'No staff assigned yet'}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {classroomMembers.map((member) => (
                            <div key={member.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                                  <Users className="w-4 h-4 text-primary" />
                                </div>
                                <div>
                                  <p className="text-sm font-medium">{member.fullName || member.email}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {getRoleLabel(member.role, 'classroom')}
                                    {member.isPrimary && ` • ${t('classroom.primary') || 'Primary'}`}
                                  </p>
                                </div>
                              </div>
                              {currentInstitute.isAdmin && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleRemoveClassroomMember(member.id)}
                                >
                                  <XCircle className="w-4 h-4 text-muted-foreground" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Classroom Students Section */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-center">
                        <CardTitle className="text-base">{t('classroom.students') || 'Students'}</CardTitle>
                        <Button size="sm" onClick={() => {
                          loadInstituteStudents(); // Make sure students list is fresh
                          setShowClassroomStudentDialog(true);
                        }}>
                          <UserPlus className="w-4 h-4 me-2" />
                          {t('classroom.addStudent') || 'Add Student'}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {loadingClassroomStudents ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : classroomStudents.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          {t('classroom.noStudents') || 'No students enrolled yet'}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {classroomStudents.map((student) => (
                            <div key={student.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center">
                                  <GraduationCap className="w-4 h-4 text-green-600" />
                                </div>
                                <div>
                                  <p className="text-sm font-medium">{student.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {student.isPrimary && `${t('classroom.primaryClassroom') || 'Primary Classroom'}`}
                                    {student.notes && ` • ${student.notes}`}
                                  </p>
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRemoveClassroomStudent(student.id)}
                              >
                                <XCircle className="w-4 h-4 text-muted-foreground" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          )}

          {/* Students Tab */}
          {activeTab === 'students' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">{t('institute.students') || 'Students'}</h2>
                {currentInstitute.isAdmin && (
                  <Button
                    onClick={() => {
                      setInstituteStudentForm({ studentId: '', grade: '', idNumber: '' });
                      setShowAddInstituteStudentDialog(true);
                    }}
                    disabled={availableStudentsToAdd.length === 0}
                  >
                    <UserPlus className="w-4 h-4 me-2" />
                    {t('institute.addStudent') || 'Add Student'}
                  </Button>
                )}
              </div>

              {loadingInstituteStudents ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : instituteStudents.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center">
                    <GraduationCap className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">{t('institute.noStudents') || 'No students assigned yet'}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {currentInstitute.isAdmin && availableStudentsToAdd.length > 0
                        ? (t('institute.noStudentsHintAdmin') || 'Click "Add Student" to assign students to this institute')
                        : (t('institute.noStudentsHint') || 'Assign students through the student management panel')}
                    </p>
                    {currentInstitute.isAdmin && availableStudentsToAdd.length > 0 && (
                      <Button
                        className="mt-4"
                        onClick={() => {
                          setInstituteStudentForm({ studentId: '', grade: '', idNumber: '' });
                          setShowAddInstituteStudentDialog(true);
                        }}
                      >
                        <UserPlus className="w-4 h-4 me-2" />
                        {t('institute.addStudent') || 'Add Student'}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {instituteStudents.map((student) => (
                    <Card key={student.id}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
                              <GraduationCap className="w-5 h-5 text-green-600" />
                            </div>
                            <div>
                              <p className="font-medium">{student.name}</p>
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                {student.grade && <Badge variant="outline">{getGradeLabel(student.grade)}</Badge>}
                                {student.idNumber && <span>ID: {student.idNumber}</span>}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {student.enrollmentDate && (
                              <span className="text-xs text-muted-foreground">
                                {t('institute.enrolled') || 'Enrolled'}: {new Date(student.enrollmentDate).toLocaleDateString()}
                              </span>
                            )}
                            {currentInstitute.isAdmin && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label="Student actions">
                                    <MoreHorizontal className="w-4 h-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuLabel>{t('common.actions') || 'Actions'}</DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => openEditInstituteStudentDialog(student)}>
                                    <Edit className="w-4 h-4 me-2" />
                                    {t('institute.editEnrollment') || 'Edit Enrollment'}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onClick={() => openRemoveInstituteStudentConfirm(student)}
                                  >
                                    <Trash2 className="w-4 h-4 me-2" />
                                    {t('institute.removeStudent') || 'Remove from Institute'}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Invites Tab */}
          {activeTab === 'invites' && currentInstitute.isAdmin && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">{t('institute.invites') || 'Invitations'}</h2>
                <Button onClick={() => setShowInviteDialog(true)}>
                  <Mail className="w-4 h-4 me-2" />
                  {t('institute.sendInvite') || 'Send Invite'}
                </Button>
              </div>
              
              {loadingInvites ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : invites.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center">
                    <Mail className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">{t('institute.noInvites') || 'No pending invitations'}</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {invites.map((invite) => (
                    <Card key={invite.id}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium">{invite.inviteeEmail}</p>
                            <div className="flex items-center gap-2 mt-1">
                              {getStatusBadge(invite.status)}
                              <Badge variant="outline">{getRoleLabel(invite.role, 'institute')}</Badge>
                              {invite.grantAdmin && (
                                <Badge variant="secondary">
                                  <Crown className="w-3 h-3 me-1" />
                                  {t('institute.admin') || 'Admin'}
                                </Badge>
                              )}
                            </div>
                          </div>
                          {invite.status === 'pending' && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Invite actions">
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                                <DropdownMenuItem onClick={() => handleResendInvite(invite.id)}>
                                  <RefreshCw className="w-4 h-4 me-2" />
                                  {t('institute.resend') || 'Resend'}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleCancelInvite(invite.id)}
                                >
                                  <XCircle className="w-4 h-4 me-2" />
                                  {t('institute.cancel') || 'Cancel'}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && currentInstitute.isAdmin && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t('institute.dangerZone') || 'Danger Zone'}</CardTitle>
                  <CardDescription>
                    {t('institute.dangerZoneDesc') || 'Irreversible actions for this institute'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="destructive"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="w-4 h-4 me-2" />
                    {t('institute.deleteInstitute') || 'Delete Institute'}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* ======================================================================== */}
      {/* DIALOGS */}
      {/* ======================================================================== */}

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('institute.inviteMember') || 'Invite Member'}</DialogTitle>
            <DialogDescription>
              {t('institute.inviteMemberDesc') || 'Send an invitation to join this institute.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="inviteEmail">{t('institute.email') || 'Email'} *</Label>
              <Input
                id="inviteEmail"
                type="email"
                dir="ltr"
                value={inviteForm.email}
                onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                placeholder="email@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteRole">{t('institute.role') || 'Role'}</Label>
              <Select
                value={inviteForm.role}
                onValueChange={(value) => setInviteForm({ ...inviteForm, role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INSTITUTE_ROLES.map((role) => (
                    <SelectItem key={role.value} value={role.value}>
                      {t(role.labelKey) || role.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="grantAdmin">{t('institute.grantAdmin') || 'Grant Admin Access'}</Label>
              <Switch
                id="grantAdmin"
                checked={inviteForm.grantAdmin}
                onCheckedChange={(checked) => setInviteForm({ ...inviteForm, grantAdmin: checked })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteMessage">{t('institute.message') || 'Message (Optional)'}</Label>
              <Textarea
                id="inviteMessage"
                value={inviteForm.message}
                onChange={(e) => setInviteForm({ ...inviteForm, message: e.target.value })}
                placeholder={t('institute.messagePlaceholder') || 'Add a personal message...'}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteDialog(false)}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={handleSendInvite} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('institute.sendInvite') || 'Send Invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Institute Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => {
        setShowEditDialog(open);
        if (!open) { setLogoFile(null); setLogoPreview(null); }
      }}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('institute.edit') || 'Edit Institute'}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            {/* Logo upload */}
            <div className="space-y-2">
              <Label>{t('institute.logo') || 'Logo'}</Label>
              <div className="flex items-center gap-4">
                {(logoPreview || editForm.logoUrl) && (
                  <img
                    src={logoPreview || editForm.logoUrl}
                    alt="Logo"
                    className="w-16 h-16 rounded object-cover border"
                  />
                )}
                <div className="flex-1">
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const maxSizeMB = 10;
                        if (file.size > maxSizeMB * 1024 * 1024) {
                          toast({
                            title: t('institute.error') || 'Error',
                            description: t('institute.fileTooLarge', { max: `${maxSizeMB}MB` }) || `File is too large. Maximum size is ${maxSizeMB}MB.`,
                            variant: 'destructive',
                          });
                          e.target.value = '';
                          return;
                        }
                        setLogoFile(file);
                        setLogoPreview(URL.createObjectURL(file));
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('institute.logoHint') || 'JPG, PNG up to 10MB'}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="editName">{t('institute.name') || 'Name'}</Label>
              <Input
                id="editName"
                value={editForm.name || ''}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editDescription">{t('institute.description') || 'Description'}</Label>
              <Textarea
                id="editDescription"
                value={editForm.description || ''}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editAddress">{t('institute.address') || 'Address'}</Label>
              <Input
                id="editAddress"
                value={editForm.address || ''}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="editPhone">{t('institute.phone') || 'Phone'}</Label>
                <Input
                  id="editPhone"
                  dir="ltr"
                  value={editForm.phone || ''}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="editEmail">{t('institute.email') || 'Email'}</Label>
                <Input
                  id="editEmail"
                  type="email"
                  dir="ltr"
                  value={editForm.email || ''}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="editWebsite">{t('institute.website') || 'Website'}</Label>
              <Input
                id="editWebsite"
                dir="ltr"
                value={editForm.website || ''}
                onChange={(e) => setEditForm({ ...editForm, website: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="editIdNumber">{t('institute.idNumber') || 'Institute ID'}</Label>
                <Input
                  id="editIdNumber"
                  dir="ltr"
                  value={editForm.instituteIdNumber || ''}
                  onChange={(e) => setEditForm({ ...editForm, instituteIdNumber: e.target.value })}
                  placeholder={t('institute.idNumberPlaceholder') || 'e.g. 123456'}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="editIdType">{t('institute.idType') || 'ID Type'}</Label>
                <Input
                  id="editIdType"
                  value={editForm.instituteIdType || ''}
                  onChange={(e) => setEditForm({ ...editForm, instituteIdType: e.target.value })}
                  placeholder={t('institute.idTypePlaceholder') || 'e.g. MOE, MOH'}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="editLanguage">{t('institute.language') || 'Language'}</Label>
              <Select
                value={editForm.language || ''}
                onValueChange={(value) => setEditForm({ ...editForm, language: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('institute.languagePlaceholder') || 'Select language...'} />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      <span className="flex items-center gap-2">
                        <Languages className="w-4 h-4" />
                        {lang.name} ({lang.nativeName})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="editTimezone">{t('institute.timezone') || 'Timezone'}</Label>
              <Input
                id="editTimezone"
                value={editForm.timezone || ''}
                onChange={(e) => setEditForm({ ...editForm, timezone: e.target.value })}
                placeholder={t('institute.timezonePlaceholder') || 'e.g. America/New_York, Asia/Jerusalem'}
              />
              <p className="text-xs text-muted-foreground">
                {t('institute.timezoneHelp') || 'IANA timezone name. Used for billing day boundaries. Leave blank to use UTC.'}
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={handleUpdateInstitute} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.save') || 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Classroom Create/Edit Dialog */}
      <Dialog open={showClassroomDialog} onOpenChange={setShowClassroomDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingClassroom
                ? (t('classroom.edit') || 'Edit Classroom')
                : (t('classroom.create') || 'Create Classroom')}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="classroomName">{t('classroom.name') || 'Name'} *</Label>
              <Input
                id="classroomName"
                value={classroomForm.name}
                onChange={(e) => setClassroomForm({ ...classroomForm, name: e.target.value })}
                placeholder={t('classroom.namePlaceholder') || 'e.g., Room 101, Blue Class'}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="classroomGrade">{t('classroom.grade') || 'Grade'}</Label>
                <Select
                  value={classroomForm.grade}
                  onValueChange={(value) => setClassroomForm({ ...classroomForm, grade: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('classroom.selectGrade') || 'Select grade'} />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADE_OPTIONS.map((grade) => (
                      <SelectItem key={grade.value} value={grade.value}>
                        {t(`classroom.grades.${grade.value}`) || grade.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="classroomRoom">{t('classroom.roomNumber') || 'Room Number'}</Label>
                <Input
                  id="classroomRoom"
                  value={classroomForm.roomNumber}
                  onChange={(e) => setClassroomForm({ ...classroomForm, roomNumber: e.target.value })}
                  placeholder="---"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="classroomCapacity">{t('classroom.capacity') || 'Capacity'}</Label>
                <Input
                  id="classroomCapacity"
                  type="number"
                  value={classroomForm.capacity}
                  onChange={(e) => setClassroomForm({ ...classroomForm, capacity: e.target.value })}
                  placeholder="---"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="classroomYear">{t('classroom.academicYear') || 'Academic Year'}</Label>
                <Input
                  id="classroomYear"
                  value={classroomForm.academicYear}
                  onChange={(e) => setClassroomForm({ ...classroomForm, academicYear: e.target.value })}
                  placeholder="---"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="classroomDescription">{t('classroom.description') || 'Description'}</Label>
              <Textarea
                id="classroomDescription"
                value={classroomForm.description}
                onChange={(e) => setClassroomForm({ ...classroomForm, description: e.target.value })}
                placeholder={t('classroom.descriptionPlaceholder') || 'Brief description of the classroom...'}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowClassroomDialog(false);
              setEditingClassroom(null);
              setClassroomForm({ name: '', grade: '', description: '', capacity: '', roomNumber: '', academicYear: '' });
            }}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button 
              onClick={editingClassroom ? handleUpdateClassroom : handleCreateClassroom} 
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {editingClassroom ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Member to Classroom Dialog */}
      <Dialog open={showClassroomMemberDialog} onOpenChange={setShowClassroomMemberDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('classroom.addMember') || 'Add Staff to Classroom'}</DialogTitle>
            <DialogDescription>
              {t('classroom.addMemberDesc') || 'Assign an institute member to this classroom.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('classroom.selectMember') || 'Select Staff Member'}</Label>
              <Select
                value={classroomMemberForm.userId}
                onValueChange={(value) => setClassroomMemberForm({ ...classroomMemberForm, userId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('classroom.selectMemberPlaceholder') || 'Choose a member...'} />
                </SelectTrigger>
                <SelectContent>
                  {getAvailableMembers().map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.fullName || member.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {getAvailableMembers().length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('classroom.noAvailableMembers') || 'All institute members are already assigned to this classroom.'}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('classroom.role') || 'Role'}</Label>
              <Select
                value={classroomMemberForm.role}
                onValueChange={(value) => setClassroomMemberForm({ ...classroomMemberForm, role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLASSROOM_ROLES.map((role) => (
                    <SelectItem key={role.value} value={role.value}>
                      {t(role.labelKey) || role.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="memberPrimary">{t('classroom.isPrimary') || 'Primary Assignment'}</Label>
              <Switch
                id="memberPrimary"
                checked={classroomMemberForm.isPrimary}
                onCheckedChange={(checked) => setClassroomMemberForm({ ...classroomMemberForm, isPrimary: checked })}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowClassroomMemberDialog(false);
              setClassroomMemberForm({ userId: '', role: 'aide', isPrimary: false });
            }}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button 
              onClick={handleAddClassroomMember} 
              disabled={isSubmitting || !classroomMemberForm.userId}
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('classroom.add') || 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Student to Classroom Dialog */}
      <Dialog open={showClassroomStudentDialog} onOpenChange={setShowClassroomStudentDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('classroom.addStudent') || 'Add Student to Classroom'}</DialogTitle>
            <DialogDescription>
              {t('classroom.addStudentDesc') || 'Enroll a student in this classroom.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('classroom.selectStudent') || 'Select Student'}</Label>
              <Select
                value={classroomStudentForm.studentId}
                onValueChange={(value) => setClassroomStudentForm({ ...classroomStudentForm, studentId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('classroom.selectStudentPlaceholder') || 'Choose a student...'} />
                </SelectTrigger>
                <SelectContent>
                  {getAvailableStudents().map((student) => (
                    <SelectItem key={student.id} value={student.id}>
                      {student.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {getAvailableStudents().length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('classroom.noAvailableStudents') || 'All assigned students are already in this classroom.'}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="studentPrimary">{t('classroom.isPrimaryClassroom') || 'Primary Classroom'}</Label>
              <Switch
                id="studentPrimary"
                checked={classroomStudentForm.isPrimary}
                onCheckedChange={(checked) => setClassroomStudentForm({ ...classroomStudentForm, isPrimary: checked })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studentNotes">{t('classroom.notes') || 'Notes (Optional)'}</Label>
              <Input
                id="studentNotes"
                value={classroomStudentForm.notes}
                onChange={(e) => setClassroomStudentForm({ ...classroomStudentForm, notes: e.target.value })}
                placeholder={t('classroom.notesPlaceholder') || 'Any special notes...'}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowClassroomStudentDialog(false);
              setClassroomStudentForm({ studentId: '', isPrimary: true, notes: '' });
            }}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button 
              onClick={handleAddClassroomStudent} 
              disabled={isSubmitting || !classroomStudentForm.studentId}
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('classroom.add') || 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Institute Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('institute.confirmDelete') || 'Delete Institute?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('institute.confirmDeleteDesc') || 'This action cannot be undone. All members will lose access.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteInstitute}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.delete') || 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Leave Institute Confirmation */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('institute.confirmLeave') || 'Leave Institute?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('institute.confirmLeaveDesc') || 'You will lose access to this institute. You can rejoin if invited again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={handleLeaveInstitute}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('institute.leave') || 'Leave'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Classroom Confirmation */}
      <AlertDialog open={showClassroomDeleteConfirm} onOpenChange={setShowClassroomDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('classroom.confirmDelete') || 'Delete Classroom?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('classroom.confirmDeleteDesc') || 'This will remove all member and student assignments. This action cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteClassroom}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.delete') || 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Student to Institute Dialog */}
      <Dialog open={showAddInstituteStudentDialog} onOpenChange={setShowAddInstituteStudentDialog}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle>{t('institute.addStudent') || 'Add Student to Institute'}</DialogTitle>
            <DialogDescription>
              {t('institute.addStudentDesc') || 'Select a student to add to this institute.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('institute.selectStudent') || 'Student'} *</Label>
              <Select
                value={instituteStudentForm.studentId}
                onValueChange={(value) => setInstituteStudentForm(prev => ({ ...prev, studentId: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('institute.selectStudentPlaceholder') || 'Select a student...'} />
                </SelectTrigger>
                <SelectContent>
                  {availableStudentsToAdd.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground text-center">
                      {t('institute.noAvailableStudents') || 'All your students are already in this institute'}
                    </div>
                  ) : (
                    availableStudentsToAdd.map((student) => (
                      <SelectItem key={student.id} value={student.id}>
                        <span className="flex items-center gap-2">
                          <GraduationCap className="w-4 h-4" />
                          {student.name}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('institute.grade') || 'Grade Level'}</Label>
              <Select
                value={instituteStudentForm.grade}
                onValueChange={(value) => setInstituteStudentForm(prev => ({ ...prev, grade: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('institute.selectGrade') || 'Select grade...'} />
                </SelectTrigger>
                <SelectContent>
                  {GRADE_OPTIONS.map((grade) => (
                    <SelectItem key={grade.value} value={grade.value}>
                      {t(`student.grades.${grade.value}`) || grade.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('institute.studentIdNumber') || 'Student ID Number'}</Label>
              <Input
                value={instituteStudentForm.idNumber}
                onChange={(e) => setInstituteStudentForm(prev => ({ ...prev, idNumber: e.target.value }))}
                placeholder={t('institute.studentIdPlaceholder') || 'Institution ID (optional)'}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowAddInstituteStudentDialog(false);
              setInstituteStudentForm({ studentId: '', grade: '', idNumber: '' });
            }}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button
              onClick={handleAddInstituteStudent}
              disabled={isSubmitting || !instituteStudentForm.studentId}
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('institute.add') || 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Student Enrollment Dialog */}
      <Dialog open={showEditInstituteStudentDialog} onOpenChange={setShowEditInstituteStudentDialog}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle>{t('institute.editEnrollment') || 'Edit Enrollment'}</DialogTitle>
            <DialogDescription>
              {selectedInstituteStudent?.name
                ? (t('institute.editEnrollmentDescNamed') || `Update enrollment details for ${selectedInstituteStudent.name}`).replace('${selectedInstituteStudent.name}', selectedInstituteStudent.name)
                : (t('institute.editEnrollmentDesc') || 'Update student enrollment details.')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('institute.grade') || 'Grade Level'}</Label>
              <Select
                value={instituteStudentForm.grade}
                onValueChange={(value) => setInstituteStudentForm(prev => ({ ...prev, grade: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('institute.selectGrade') || 'Select grade...'} />
                </SelectTrigger>
                <SelectContent>
                  {GRADE_OPTIONS.map((grade) => (
                    <SelectItem key={grade.value} value={grade.value}>
                      {t(`student.grades.${grade.value}`) || grade.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('institute.studentIdNumber') || 'Student ID Number'}</Label>
              <Input
                value={instituteStudentForm.idNumber}
                onChange={(e) => setInstituteStudentForm(prev => ({ ...prev, idNumber: e.target.value }))}
                placeholder={t('institute.studentIdPlaceholder') || 'Institution ID (optional)'}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowEditInstituteStudentDialog(false);
              setSelectedInstituteStudent(null);
              setInstituteStudentForm({ studentId: '', grade: '', idNumber: '' });
            }}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={handleEditInstituteStudent} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.save') || 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Student from Institute Confirmation */}
      <AlertDialog open={showRemoveInstituteStudentConfirm} onOpenChange={setShowRemoveInstituteStudentConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              {t('institute.confirmRemoveStudent') || 'Remove Student from Institute?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedInstituteStudent?.name
                ? (t('institute.confirmRemoveStudentDescNamed') || `Are you sure you want to remove ${selectedInstituteStudent.name} from this institute? They will also be removed from any classrooms in this institute.`).replace('${selectedInstituteStudent.name}', selectedInstituteStudent.name)
                : (t('institute.confirmRemoveStudentDesc') || 'This student will be removed from this institute and any associated classrooms.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setShowRemoveInstituteStudentConfirm(false);
              setSelectedInstituteStudent(null);
            }}>
              {t('common.cancel') || 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveInstituteStudent}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('institute.remove') || 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}