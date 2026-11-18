// Slice 3: Project skills manager modal (editor+).
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useState, type FC } from 'react';
import MantineModal from '../../../components/common/MantineModal';
import { useAgentBiSkills } from '../hooks/useAgentBiSkills';
import { useAgentBiLocale } from '../i18n/agentBiLocale';

type Props = {
    onClose: () => void;
    opened: boolean;
    projectUuid: string;
};

const ProjectSkillsModal: FC<Props> = ({ onClose, opened, projectUuid }) => {
    const { t } = useAgentBiLocale();
    const { data: skills, create, remove } = useAgentBiSkills(projectUuid);
    const [slug, setSlug] = useState('');
    const [description, setDescription] = useState('');

    const handleCreate = async () => {
        if (slug.trim().length === 0) {
            return;
        }
        await create({
            manifest: { description: description.trim() || slug.trim() },
            slug: slug.trim(),
        });
        setSlug('');
        setDescription('');
    };

    return (
        <MantineModal
            opened={opened}
            onClose={onClose}
            title={t('skills.modalTitle')}
        >
            <Stack gap="md">
                <Stack gap="sm">
                    <TextInput
                        aria-label={t('skills.slugLabel')}
                        label={t('skills.slugLabel')}
                        value={slug}
                        onChange={(event) => setSlug(event.currentTarget.value)}
                    />
                    <TextInput
                        aria-label={t('skills.descriptionLabel')}
                        label={t('skills.descriptionLabel')}
                        value={description}
                        onChange={(event) =>
                            setDescription(event.currentTarget.value)
                        }
                    />
                    <Button onClick={() => void handleCreate()}>
                        {t('skills.addButton')}
                    </Button>
                </Stack>
                {(skills ?? []).map((skill) => (
                    <Group key={skill.skillUuid} justify="space-between">
                        <Text fz="sm" fw={500}>
                            {skill.slug}
                        </Text>
                        <Button
                            variant="subtle"
                            color="red"
                            size="xs"
                            onClick={() => void remove(skill.skillUuid)}
                        >
                            {t('skills.deleteButton')}
                        </Button>
                    </Group>
                ))}
            </Stack>
        </MantineModal>
    );
};

export default ProjectSkillsModal;
