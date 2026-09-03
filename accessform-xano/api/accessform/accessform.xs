// AccessForm control plane. The Next.js app and the Vapi voice agent both talk
// only to this group. Xano is the system of record and owns completeness -
// nothing downstream recomputes whether an application is done.
api_group AccessForm {
  canonical = "accessform"
  description = "AccessForm: cases, answers, requirements, authoritative completeness, discovered programs."

  tags = ["accessform"]
  guid = "SOagDzIuTQK8VSlTCf2dm-fPYaE"
}
